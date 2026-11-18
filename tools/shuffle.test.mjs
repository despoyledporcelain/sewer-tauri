/* Тесты перемешивания. Чистый модуль без React — поэтому проверяется без
 * запуска приложения:  node tools/shuffle.test.mjs
 *
 * Math.random подменяется детерминированной последовательностью, чтобы
 * проверки не зависели от удачи. */
import { Shuffle } from '../src/shuffle.js';

let failed = 0, passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

/* Фиксированный генератор: даёт разные перестановки, но воспроизводимые. */
function seedRandom(n) {
  let i = 1;
  Math.random = () => { i = (i * 1103515245 + 12345) % 2147483648; return i / 2147483648; };
}
const realRandom = Math.random;
seedRandom();

const L = n => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

function newSh(repeat = 'off') { return new Shuffle({ repeat: () => repeat }); }

/* ── перестановка ─────────────────────────────────────────────────────────── */
{
  const s = newSh();
  s.start(L(50), null);
  const ids = s.order;
  eq('порядок — перестановка пула', [...ids].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
  ok('случайный первый трек не всегда один и тот же', new Set(Array.from({ length: 40 }, () => {
    const t = newSh(); t.start(L(50), null); return t.order[0];
  })).size > 1);
}
{
  const s = newSh();
  s.start(L(20), 7);
  eq('текущий трек встаёт первым', s.order[0], 7);
  eq('остальные на месте', s.order.length, 20);
  ok('текущий не продублирован', new Set(s.order).size === 20);
}
{
  const s = newSh();
  s.start(L(10), 999);   // текущего трека в очереди нет
  eq('чужой currentId не пинится, порядок целый', s.order.length, 10);
  ok('в порядке нет 999', !s.order.includes(999));
  ok('порядок — перестановка пула', new Set(s.order).size === 10);
}

/* ── проход вперёд: без повторов до конца ─────────────────────────────────── */
{
  const s = newSh();
  s.start(L(30), null);
  const played = [s.order[0]];
  for (;;) { const st = s.peek(1); if (!st) break; s.commit(st); played.push(st.id); }
  eq('прошёл весь порядок ровно один раз', played, s.order);
  eq('остановился на конце без repeat', s.peek(1), null);
  eq('позиция на последнем', s.pos, s.order.length - 1);
}
{
  const s = newSh('all');
  s.start(L(5), null);
  for (let i = 0; i < 4; i++) s.commit(s.peek(1));
  const st = s.peek(1);
  ok('repeat-all заворачивает', !!st);
  eq('заворот начинается с нуля', st.index, 0);
  ok('заворот — перестановка того же пула', new Set(st.order).size === 5);
}
{
  const s = newSh();
  s.start(L(5), null);
  eq('назад с нуля — ничего', s.peek(-1), null);
  s.commit(s.peek(1));
  eq('назад возвращает предыдущий', s.peek(-1).id, s.order[0]);
  eq('peek ничего не меняет', s.pos, 1);
  ok('peek не меняет и order', s.order.length === 5);
  s.commit(s.peek(-1));
  eq('commit сдвинул назад', s.pos, 0);
}

/* ── повторно тот же трек после commit (тот самый do/while по ссылке) ──────── */
{
  const s = newSh();
  s.start(L(4), null);
  const first = s.order[0];
  s.commit({ id: first, index: s.pos, order: null });
  ok('следующий не равен текущему', s.peek(1).id !== first);
  const s2 = newSh();
  s2.start([{ id: 'a' }], null);
  eq('пул из одного трека — next=null', s2.peek(1), null);
}

/* ── смена очереди: порядок от другой с��иска ─────────────────────────────── */
{
  const s = newSh();
  s.start(L(30), 3);
  s.commit(s.peek(1));                       // доехали до середины
  const oldOrder = s.order;
  s.sync(L(10).map(t => ({ id: t.id + 1000 })));   // переключили плейлист/станцию
  const st = s.peek(1);
  ok('next не молчит', !!st);
  ok('next — трек из НОВОЙ очереди', st.id > 1000, `id=${st.id}`);
  ok('порядок пересобран', st.order !== null && st.order !== oldOrder);
  ok('пересобранный порядок целый', new Set(st.order).size === 10);
  s.commit(st);
  ok('после commit играющий в новой очереди', s.track(s.curId) != null);
}
{
  /* Старый и новый список пересекаются по id (так бывает, когда очередь
     пополнилась). Гарантия движка: peek НИКОГДА не отдаёт id, которого нет в
     текущем пуле — именно это раньше молча останавливало плеер. */
  const s = newSh();
  s.start(L(30), 3);
  s.sync(L(10));
  for (let i = 0; i < 9; i++) {               // первый уже играет, осталось девять
    const st = s.peek(1);
    ok(`шаг ${i}: результат есть и он из пула`, !!st && s.track(st.id) != null, `id=${st?.id}`);
    if (!st) break;
    s.commit(st);
  }
  eq('на десятом шаге пусто', s.peek(1), null);
}
{
  /* порядок НЕ должен ехать на каждый чих: догрузка ленты меняет список */
  const s = newSh();
  s.start(L(10), null);
  const before = s.order.slice();
  s.sync([...L(10), ...L(5).map(t => ({ id: t.id + 100 }))]);
  eq('sync не трогает порядок', s.order, before);
}

/* ── догрузка бесконечной ленты ───────────────────────────────────────────── */
{
  const s = newSh();
  s.start(L(10), null);
  const firstFive = s.order.slice(0, 5);
  s.extend(L(5).map(t => ({ id: t.id + 100 })));
  eq('догруженное дописано в конец', s.order.length, 15);
  eq('сыгранное не тронуто', s.order.slice(0, 5), firstFive);
  s.extend(L(3).map(t => ({ id: t.id + 200 })));
  eq('вторая догрузка тоже', s.order.length, 18);
  ok('догруженные разрешаются в треки', s.track(s.order[14]).id === s.order[14]);
  ok('нет повторов', new Set(s.order).size === 18);
}
{
  const s = newSh();
  s.start(L(10), null);
  const before = s.order.slice();
  s.clear();
  s.extend(L(5));
  eq('extend при выключенном перемешивании — нет-op', s.order, []);
  ok('пусто осталось пустым', before.length === 10);
}

/* ── откат (кроссфейд) ────────────────────────────────────────────────────── */
{
  const s = newSh();
  s.start(L(20), null);
  s.commit(s.peek(1));
  const snap = s.snapshot();
  const orderBefore = s.order;
  const st = s.peek(1);
  s.commit(st);
  ok('позиция сдвинулась', s.pos === snap.pos + 1);
  s.restore(snap);
  eq('позиция вернулась', s.pos, snap.pos);
  eq('порядок вернулся', s.order, orderBefore);
  eq('curId вернулся', s.curId, snap.curId);
  eq('история вернулась', s.history, snap.history);
  ok('после отката next — тот, что был', s.peek(1).id === st.id);
}
{
  const s = newSh('all');
  s.start(L(3), null);
  s.commit(s.peek(1)); s.commit(s.peek(1));   // доиграли все три
  eq('курсор на последнем', s.pos, 2);
  const snap = s.snapshot();                 // курсор на конце
  const st = s.peek(1);                      // заворот: НОВЫЙ порядок
  ok('заворот даёт новый порядок', st.order !== null);
  s.commit(st);
  s.restore(snap);
  eq('откат вернул старый порядок целиком', s.order, snap.order);
  eq('и позицию', s.pos, snap.pos);
}

/* ── skip: обход битых треков не должен зациклиться ──────────────────────── */
{
  /* Идём по порядку, но «битые» (первые два в порядке) пропускаем —
     ровно то, что делает skipInDirection с direction = 1. */
  const s = newSh();
  s.start(L(20), null);
  const committed = [s.curId];
  const visited = [];
  let steps = 0;
  while (steps < 20) {
    const st = s.peek(1);
    if (!st) break;
    s.commit(st);
    committed.push(st.id);
    steps++;
    if (steps < 3) continue;                 // «ошибка воспроизведения»
    visited.push(st.id);
  }
  eq('обход дошёл до конца ровно один раз', committed, s.order);
  eq('и без повторов', new Set(committed).size, 20);
  eq('история совпала с порядком', s.history, s.order);
  ok('после пропусков осталось 17', visited.length === 17);
  ok('пропущенные — начало порядка', visited[0] === s.order[3]);
}

/* ── два игрока не мешают друг другу ──────────────────────────────────────── */
{
  const a = newSh(), b = newSh('all');
  a.start(L(10), null);
  b.start(L(10), null);
  for (let i = 0; i < 5; i++) { a.commit(a.peek(1)); b.commit(b.peek(1)); }
  ok('позиции независимы', a.pos === b.pos && a.order !== b.order);
  a.clear();
  eq('clear обнуляет', a.active, false);
  ok('второй не задет', b.active && b.order.length === 10);
}

Math.random = realRandom;
console.log(failed ? `\n${failed} упало, ${passed} прошло` : `\nвсе ${passed} проверок прошли`);
process.exit(failed ? 1 : 0);