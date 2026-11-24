import { moveQueueItem } from './playback-queue.js';

/* Перемешивание: перестановка + курсор. Одно место, где живёт порядок.
 *
 * Раньше порядок перемешивания был размазан по десяти местам app.jsx: массив
 * id в scShuffleOrderRef, курсор в scShuffleIdxRef, плюс флаг shuffleKeepRef,
 * чтобы эффект [shuffle] не пересобирал порядок сразу после того, как его
 * собрали. Каждый следующий/переход/кроссфейд двигал курсор руками, и все эти
 * места должны были сходиться между собой.
 *
 * Здесь всё это сведено к одному объекту:
 *
 *   order    id в порядке воспроизведения (одна перестановка пула)
 *   pos      индекс ИГРАЮЩЕГО трека в order
 *   curId    id играющего — на него пересобираем порядок при ручном клике
 *   poolIds  пул, из которого построен order
 *
 * И важное разделение: peek() НИЧЕГО не меняет, commit() — меняет. Раньше
 * peekNextSc возвращал новый порядок, который кроссфейд коммитил только если
 * переключение действительно случилось, иначе откатывался. Здесь то же самое
 * выражено прямо: peek -> попытка переключения -> commit, а snapshot/restore
 * для отката.
 *
 * Раньше ещё и порядок мог уехать: он строился из списка, пришедшего с кнопки
 * (лайки / чип плейлиста / активная очередь), а next искал трек в ДРУГОМ
 * списке — scQueueList(). Расхождение молча останавливало плеер. Здесь peek
 * сам проверяет, что найденный id ещё жив в очереди, и пересобирает порядок.
 */

/* Фишер-Йетс. Ничего не возвращает — мутирует на месте. */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Shuffle {
  /* repeat — функция () => 'off' | 'all' | 'one': движок не знает про React и
     читает её в момент peek, как это делает остальной плеер через repeatRef. */
  constructor({ repeat } = {}) {
    this.repeat = repeat || (() => 'off');
    this.clear();
  }

  clear() {
    this.order   = [];
    this.pos     = -1;
    this.curId   = null;
    this.history = [];
    this.poolIds = [];
    this._list   = null;
    this._byId   = new Map();
    this._preview = null;
  }

  /* Есть ли вообще что перемешивать. Пустой order = перемешивания нет, даже если
     флаг в интерфейсе включён (например, включили в мини-плеере, когда играет
     локальный трек и SC-очереди не существует). */
  get active() { return this.order.length > 0; }

  /* Сколько треков осталось после играющего — по этому числу решается, пора ли
     догружать бесконечную ленту. */
  left() { return this.order.length ? this.order.length - 1 - this.pos : 0; }

  /* Пул = список, из которого реально играет next. Обновляем карту id -> трек
     и id-пул, порядок НЕ трогаем: догрузка ленты меняет список на каждой
     странице, и пересборка на каждый чих выбрасывала бы уже сыгранное.
     Пересборка живёт в rebuild()/start() и вызывается оттуда, где очередь
     действительно сменилась. */
  sync(list) {
    if (!Array.isArray(list) || list === this._list) return;
    this._list = list;
    this._byId = new Map();
    const ids = [];
    for (const t of list) {
      if (!t) continue;
      this._byId.set(t.id, t);
      ids.push(t.id);
    }
    if (ids.length !== this.poolIds.length || ids.some((id, index) => id !== this.poolIds[index])) {
      this._preview = null;
    }
    this.poolIds = ids;
  }

  track(id) { return this._byId.get(id) || null; }

  /* Новая перестановка. currentId, если он есть в пуле, встаёт первым — чтобы
     включение перемешивания не выкидывало трек, который уже играет. Если его в
     пуле нет (отсеял поиск, сменилась очередь) — просто не пиним его: раньше
     filter() молча выкидывал такой id, и он пропадал из порядка навсегда. */
  #shuffle(poolIds, currentId) {
    const rest = [];
    let hasCur = false;
    for (const id of poolIds) {
      if (id === currentId) { hasCur = true; continue; }
      rest.push(id);
    }
    shuffleInPlace(rest);
    if (hasCur) rest.unshift(currentId);
    return rest;
  }

  #apply(order, curId) {
    this.order = order;
    this.pos = order.length ? 0 : -1;
    this.curId = order.length ? order[0] : curId ?? null;
    this.history = order.length ? [order[0]] : [];
    this._preview = null;
  }

  /* Включить перемешивание на переданном списке. currentId = null — случайный
     первый трек (так работает кнопка «случайно»). */
  start(list, currentId = null) {
    this.sync(list);
    this.#apply(this.#shuffle(this.poolIds, currentId), currentId);
  }

  prepare(list) {
    this.start(list);
    this.pos = -1;
    this.curId = null;
    this.history = [];
  }

  /* Ручной клик по треку: играющий встаёт первым, остальное перемешивается. */
  rebuild(currentId) {
    if (!this.poolIds.length) return;
    this.#apply(this.#shuffle(this.poolIds, currentId), currentId);
  }

  /* Догрузили ещё страницу бесконечной ленты. Новые треки дописываются в конец
     прохода: сыгранное не трогаем, курсор остаётся на месте. */
  extend(newTracks) {
    if (!this.active || !Array.isArray(newTracks) || !newTracks.length) return;
    const ids = [];
    for (const t of newTracks) {
      if (!t) continue;
      this._byId.set(t.id, t);
      ids.push(t.id);
      this.poolIds.push(t.id);
    }
    if (!ids.length) return;
    this.order.push(...shuffleInPlace(ids));
    this._preview = null;
  }

  #previewOrder(currentId) {
    if (this._preview?.currentId === currentId) return this._preview.order;
    const order = this.#shuffle(this.poolIds, currentId);
    if (currentId === null && order.length > 1 && order[0] === this.curId) {
      [order[0], order[1]] = [order[1], order[0]];
    }
    this._preview = { currentId, order };
    return order;
  }

  /* Кто следующий. dir = 1 вперёд, -1 назад. НИЧЕГО не меняет: отдаёт
     { id, index, order } — order не null, если очередь надо пересобрать,
     и тогда коммитится вместе с позицией. */
  peek(dir = 1) {
    const order = this.order;
    if (!order.length) return null;
    const ni = this.pos + dir;
    if (ni >= 0 && ni < order.length) {
      if (this._byId.has(order[ni])) return { id: order[ni], index: ni, order: null };
      /* Порядок от ДРУГОЙ очереди: плейлист/станция/поиск сменились, а
         перемешивание осталось включённым. Раньше order[ni] просто не
         находился в списке и next молча останавливал плеер. */
      const fresh = this.#previewOrder(this.curId);
      const j = fresh[0] === this.curId ? (dir > 0 ? 1 : -1) : 0;
      if (j >= 0 && j < fresh.length) return { id: fresh[j], index: j, order: fresh };
      return null;
    }
    /* Конец прохода. Вперёд и только при repeat-all заворачиваем новой
       перестановкой; назад за начало не ходим, как и раньше. */
    if (dir > 0 && this.repeat() === 'all') {
      const fresh = this.#previewOrder(null);
      return fresh.length ? { id: fresh[0], index: 0, order: fresh } : null;
    }
    return null;
  }

  upcoming() {
    const next = this.peek(1);
    if (!next) return [];
    const order = next.order || this.order;
    const steps = [];
    for (let i = next.index; i < order.length; i++) {
      if (this._byId.has(order[i])) steps.push({ id: order[i], index: i, order: next.order });
    }
    return steps;
  }

  moveUpcoming(from, to) {
    const next = this.peek(1);
    if (!next || from.order !== next.order || to.order !== next.order) return false;
    const order = next.order || this.order;
    if (from.index < next.index || to.index < next.index
      || order[from.index] !== from.id || order[to.index] !== to.id) return false;
    const reordered = moveQueueItem(order, from.index, to.index);
    if (reordered === order) return false;
    if (next.order) this._preview.order = reordered;
    else { this.order = reordered; this._preview = null; }
    return true;
  }

  /* «Он и правда заиграл». Единственное место, где двигается позиция. */
  commit(step) {
    if (!step) return;
    if (step.order) this.order = step.order;
    this._preview = null;
    this.pos = step.index;
    this.curId = step.id;
    if (this.history[this.history.length - 1] !== step.id) this.history.push(step.id);
  }

  /* Снимок позиции для отката: кроссфейд коммитит следующий трек ДО того, как
     стало ясно, запустилась ли вторая дека. Отменённое переключение обязано
     вернуть и порядок, и курсор — иначе следующий peek увидит уже сдвинутую
     позицию и «вперёд» съест два трека сразу. */
  snapshot() {
    return {
      order: this.order, pos: this.pos,
      curId: this.curId, history: this.history.slice(),
    };
  }

  restore(s) {
    if (!s) return;
    this.order   = s.order;
    this.pos     = s.pos;
    this.curId   = s.curId;
    this.history = s.history.slice();
    this._preview = null;
  }
}
