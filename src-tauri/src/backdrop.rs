//! Материал окна: Mica.
//!
//! Второе место в проекте, где нужен прямой Win32 (первое — ipc_pipe.rs).
//! Причина та же: DWM живёт в windows-sys за фичей `Win32_Graphics_Dwm`, и
//! включить её из крейта нельзя. Нулевая цена вопроса — крейт уже в дереве.
//!
//! Почему не `windowEffects` в tauri.conf.json: он задаёт эффект ОДИН РАЗ
//! при создании окна. Тумблер в настройках должен включать и выключать его на
//! живой окне, а готового API на это у v2 нет — плагин window-vibrancy эту
//! задачу решает, но тянет за собой новую зависимость ради шести строк.
//!
//! ⚠️ Скругление. Здесь оно отдано ОКНУ, а не панели, но по противоположной
//! причине, чем раньше, и это стоит проговорить.
//!
//! Панель скругляет css (`--radius`), и если окно скругляет DWM отдельно, то
//! две дуги не совпадают. Там, где радиус окна меньше радиуса панели, в углах
//! оставалась чёрная полоска — кусок самого окна, торчащий из-под скруглённой
//! панели. Поэтому при выключенном материале окну запрещается скругляться
//! вовсе (`DONOTROUND`): рисует только css, и обе дуги по определению одни.
//!
//! При ВКЛЮЧЁННОМ материале всё наоборот: DWM рисует мику по всему
//! прямоугольнику окна, мимо css-скругления, и панель уходит в `border-radius: 0`
//! (см. styles.css), а скругление окна включено обратно. Иначе в углах
//! торчали бы квадратные куски мики поверх скруглённой панели.

use std::ffi::c_void;

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DwmSetWindowAttribute, DWMSBT_MAINWINDOW, DWMSBT_NONE,
    DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE,
    DWMWCP_DONOTROUND, DWMWCP_ROUND,
};

/* Константы в windows-sys имеют тип DWMWINDOWATTRIBUTE = i32, а в вызове
   DwmSetWindowAttribute атрибут ждётся u32. Приводим здесь, один раз: в
   вызывающем коде за cast-ами не осталось бы ничего. */
const ATTR_BACKDROP: u32 = DWMWA_SYSTEMBACKDROP_TYPE as u32;
const ATTR_DARK: u32 = DWMWA_USE_IMMERSIVE_DARK_MODE as u32;
const ATTR_CORNERS: u32 = DWMWA_WINDOW_CORNER_PREFERENCE as u32;

/// `DWMWA_BORDER_COLOR`. В windows-sys этой константы нет — там выведены
/// только три атрибута про окно, — поэтому номер задан явно. Он
/// документированный и не менялся: 34.
const ATTR_BORDER: u32 = 34;

/// `DWMWA_COLOR_NONE` — «цвет не задан», `0xFFFFFF00` из `dwmapi.h`.
/// Именно это значение, а не чёрный, выключает рамку: чёрным мы бы просто
/// перекрасили её, и на тёмной теме она бы осталась. Как `i32` это -256.
const COLOR_NONE: i32 = 0xFFFF_FF00u32 as i32;

const HRESULT_OK: i32 = 0;

/// Убрать рамку окна.
///
/// DWM рисует вокруг любого верхнеуровневого окна рамку в 1px, и у frameless
/// (`decorations: false`) она никуда не девается. На скруглённой панели это
/// и есть «полоски на углах»: дуга рамки идёт по радиусу ОКНА, а панель
/// скруглена своим, и на стыке остаётся кусок рамки.
///
/// Отдельно про цвета: рамка белая, когда окно неактивно, и чёрная, когда
/// активное. Это не два разных дефекта, а одно и то же свойство окна в двух
/// состояниях, поэтому и лечится одним вызовом. Покрасить в цвет фона нельзя:
/// фон у нас прозрачный и меняется темой, а рамка всё равно осталась бы там,
/// где не совпала.
pub fn hide_border(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as HWND;
    set(hwnd, ATTR_BORDER, COLOR_NONE);
}

fn set(hwnd: HWND, attr: u32, value: i32) -> i32 {
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            attr,
            &value as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        ) as i32
    }
}

fn get(hwnd: HWND, attr: u32) -> Option<i32> {
    let mut out: i32 = 0;
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            attr,
            &mut out as *mut i32 as *mut c_void,
            std::mem::size_of::<i32>() as u32,
        )
    } as i32;
    if hr < HRESULT_OK {
        None
    } else {
        Some(out)
    }
}

/// Включить или снять материал. Возвращает, удалось ли.
///
/// Проверка не по номеру сборки windows, а по факту: DWM на windows 10 и на
/// 11 ниже 22H2 принимает неизвестный атрибут и молча ничего не рисует. Поэтому
/// после включения атрибут читается обратно — если вернулось не то, система не
/// поддерживает, и выключатель откатывается вместо того, чтобы оставить
/// полупрозрачный интерфейс без материала за ним.
pub fn apply(window: &WebviewWindow, on: bool) -> bool {
    let Ok(hwnd) = window.hwnd() else { return false };
    /* hwnd приходит из крейта `windows`, а DWM мы зовём из `windows-sys`.
       это разные крейты и один и тот же указатель: HWND у обоих — просто
       *mut c_void, поэтому достаточно приведения, новой зависимости не нужно */
    let hwnd = hwnd.0 as HWND;

    /* тёмный материал. без этого DWM рисует светлую мику, а интерфейс тёмный:
     получился бы грязный серый фон вместо облачного */
    set(hwnd, ATTR_DARK, 1);
    /* скругление окна. Без материала — запрещаем: рисует css, и две не
       совпадающие дуги оставляли в углах чёрную полоску (см. шапку модуля).
       С материалом — разрешаем, потому что скругляет уже сама мика, а панель
       при этом прямоугольная */
    set(
        hwnd,
        ATTR_CORNERS,
        if on { DWMWCP_ROUND } else { DWMWCP_DONOTROUND },
    );

    let hr = set(hwnd, ATTR_BACKDROP, if on { DWMSBT_MAINWINDOW } else { DWMSBT_NONE });
    if hr < HRESULT_OK {
        return false;
    }
    if !on {
        /* выключение всегда успешно: снятие отсутствующего материала — no-op,
           и читать обратно тут нечего: на окне, где его и не было, вернётся
           не DWMSBT_NONE, а ноль, что дало бы ложный отказ */
        return true;
    }
    get(hwnd, ATTR_BACKDROP) == Some(DWMSBT_MAINWINDOW)
}