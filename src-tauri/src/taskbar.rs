use std::cell::RefCell;

use image::{codecs::png::PngEncoder, imageops::FilterType, ImageEncoder, ImageFormat};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::{
    core::w,
    Win32::{
        Foundation::{E_FAIL, HWND, LPARAM, LRESULT, WPARAM},
        System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
        UI::{
            Shell::{
                DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass, ITaskbarList3,
                TaskbarList, THBF_DISABLED, THBF_ENABLED, THB_FLAGS, THB_ICON, THB_TOOLTIP,
                THBN_CLICKED, THUMBBUTTON,
            },
            WindowsAndMessaging::{
                CreateIconFromResourceEx, DestroyIcon, GetSystemMetrics, RegisterWindowMessageW,
                HICON, LR_DEFAULTCOLOR, SM_CXSMICON, WM_COMMAND, WM_NCDESTROY,
            },
        },
    },
};

const SUBCLASS_ID: usize = 1;
const MEDIA_EVENTS: [&str; 3] = ["media-prev", "media-play-pause", "media-next"];
const PREVIOUS_ICON: &[u8] = include_bytes!("../../public/assets/rewind.png");
const PLAY_ICON: &[u8] = include_bytes!("../../public/assets/play.png");
const PAUSE_ICON: &[u8] = include_bytes!("../../public/assets/pause.png");
const NEXT_ICON: &[u8] = include_bytes!("../../public/assets/forward.png");

#[derive(Clone, Deserialize)]
pub(crate) struct Playback {
    enabled: bool,
    playing: bool,
    labels: [String; 3],
}

struct Toolbar {
    app: AppHandle,
    ready_message: u32,
    added: bool,
    playback: Option<Playback>,
}

// SetWindowSubclass and the taskbar COM calls run on the window thread.
thread_local! {
    static TOOLBAR: RefCell<Option<Toolbar>> = const { RefCell::new(None) };
}

pub(crate) fn install(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let ready_message = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
    if ready_message == 0
        || !unsafe { SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0) }.as_bool()
    {
        eprintln!("[taskbar] could not install thumbnail toolbar");
        return;
    }
    TOOLBAR.with_borrow_mut(|toolbar| {
        *toolbar = Some(Toolbar {
            app: window.app_handle().clone(),
            ready_message,
            added: false,
            playback: None,
        });
    });
}

#[tauri::command]
pub(crate) fn set_taskbar_playback(window: WebviewWindow, state: Playback) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Thumbnail controls belong to the main window".into());
    }
    let main_window = window.clone();
    window
        .run_on_main_thread(move || {
            TOOLBAR.with_borrow_mut(|toolbar| {
                if let Some(toolbar) = toolbar {
                    toolbar.playback = Some(state);
                }
            });
            if let Ok(hwnd) = main_window.hwnd() {
                refresh(hwnd);
            }
        })
        .map_err(|err| err.to_string())
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    let is_taskbar_ready = TOOLBAR.with_borrow_mut(|toolbar| {
        let Some(toolbar) = toolbar else { return false };
        if message == toolbar.ready_message {
            toolbar.added = false;
            return true;
        }
        false
    });
    if is_taskbar_ready {
        refresh(hwnd);
    } else if message == WM_COMMAND && (wparam.0 >> 16) as u32 == THBN_CLICKED {
        if let Some(event) = MEDIA_EVENTS.get(wparam.0 & 0xffff) {
            let app = TOOLBAR.with_borrow(|toolbar| {
                let toolbar = toolbar.as_ref()?;
                toolbar.playback.as_ref()?.enabled.then(|| toolbar.app.clone())
            });
            if let Some(app) = app {
                let _ = app.emit_to("main", *event, ());
            }
            return LRESULT(0);
        }
    } else if message == WM_NCDESTROY {
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID) };
        TOOLBAR.with_borrow_mut(|toolbar| toolbar.take());
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

fn refresh(hwnd: HWND) {
    let Some((playback, added)) = TOOLBAR.with_borrow(|toolbar| {
        let toolbar = toolbar.as_ref()?;
        Some((toolbar.playback.clone()?, toolbar.added))
    }) else {
        return;
    };
    if let Err(err) = update_buttons(hwnd, &playback, added) {
        // The first renderer update can arrive before Explorer creates the button.
        // TaskbarButtonCreated retries with the most recent playback state.
        if added {
            eprintln!("[taskbar] could not update thumbnail toolbar: {err}");
        }
        return;
    }
    TOOLBAR.with_borrow_mut(|toolbar| {
        if let Some(toolbar) = toolbar {
            toolbar.added = true;
        }
    });
}

fn update_buttons(hwnd: HWND, playback: &Playback, added: bool) -> windows::core::Result<()> {
    let taskbar: ITaskbarList3 =
        unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)? };
    unsafe { taskbar.HrInit()? };
    let size = unsafe { GetSystemMetrics(SM_CXSMICON) }.max(16);
    let center_icon = if playback.playing { PAUSE_ICON } else { PLAY_ICON };
    let icons = [
        Icon::create(PREVIOUS_ICON, size)?,
        Icon::create(center_icon, size)?,
        Icon::create(NEXT_ICON, size)?,
    ];
    let buttons: [THUMBBUTTON; 3] = std::array::from_fn(|index| {
        let mut button = THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: index as u32,
            hIcon: icons[index].0,
            dwFlags: if playback.enabled { THBF_ENABLED } else { THBF_DISABLED },
            ..Default::default()
        };
        for (slot, code_unit) in button.szTip[..259].iter_mut().zip(playback.labels[index].encode_utf16()) {
            *slot = code_unit;
        }
        button
    });
    unsafe {
        if added {
            taskbar.ThumbBarUpdateButtons(hwnd, &buttons)
        } else {
            taskbar
                .ThumbBarAddButtons(hwnd, &buttons)
                .or_else(|_| taskbar.ThumbBarUpdateButtons(hwnd, &buttons))
        }
    }
}

struct Icon(HICON);

impl Icon {
    fn create(source: &[u8], size: i32) -> windows::core::Result<Self> {
        let image_error = |err: image::ImageError| {
            windows::core::Error::new(E_FAIL, err.to_string())
        };
        let mut rgba = image::load_from_memory_with_format(source, ImageFormat::Png)
            .map_err(image_error)?
            .resize_exact(size as u32, size as u32, FilterType::Lanczos3)
            .into_rgba8();
        // Match the player’s white tint and preserve the source alpha.
        for pixel in rgba.pixels_mut() {
            pixel.0[..3].fill(255);
        }
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
            .map_err(image_error)?;

        // Win32 accepts PNG icon resources and requires a DWORD-aligned pointer.
        let mut buffer = vec![0u8; png.len() + 3];
        let offset = buffer.as_ptr().align_offset(4);
        let resource = &mut buffer[offset..offset + png.len()];
        resource.copy_from_slice(&png);
        unsafe { CreateIconFromResourceEx(resource, true, 0x00030000, size, size, LR_DEFAULTCOLOR) }
            .map(Self)
    }
}

impl Drop for Icon {
    fn drop(&mut self) {
        let _ = unsafe { DestroyIcon(self.0) };
    }
}
