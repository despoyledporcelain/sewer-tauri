//! Именованные каналы discord: `\\.\pipe\discord-ipc-N`.
//!
//! Отдельный модуль, потому что это единственное место в проекте, где нужен
//! прямой Win32: `std::os::windows::net::NamedPipeClientConn` живёт за фичей
//! `named_pipe`, которую из крейта включить нельзя, поэтому здесь
//! windows-sys. Логика rpc лежит в соседнем модуле и сюда не заглядывает.
//!
//! Ключевое решение — НЕ блокирующее чтение. Дискорд-канал работает в
//! byte mode, поэтому заранее известной длины кадра нет: её даёт
//! префикс. Блокирующий ReadFile на том же дескрипте, который пишет
//! писатель, взаимоблокирует их (для синхронных дескрипторов Windows
//! блокировка чтения останавливает и запись) — а писать нужно из
//! tokio-горутины, пока читатель ждёт следующий кадр. Поэтому читатель
//! опрашивает PeekNamedPipe: данных нет — спит, данные есть — читает.

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::Sleep;

use crate::settings;

const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
const WAIT_POLL_MS: u32 = 15;

#[derive(Debug)]
pub struct Pipe(HANDLE);

// дескриптор — просто число; Sync нужно, потому что он лежит в Arc, а
// операции с ним сериализованы внешним Mutex
unsafe impl Send for Pipe {}
unsafe impl Sync for Pipe {}

impl Pipe {
    /// Открывает `\\.\pipe\discord-ipc-{idx}`. Discord держит открытыми все
    /// десять каналов, но живой ровно один: остальные отдают
    /// ERROR_PIPE_BUSY, поэтому вызывающий просто перебирает индексы.
    pub fn open(idx: u8) -> io::Result<Self> {
        let name = format!(r"\\.\pipe\discord-ipc-{idx}");
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        wide.push(0);

        unsafe {
            let handle = CreateFileW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            Ok(Pipe(handle))
        }
    }

    /// Пишет ровно `buf.len()` байт. Короткая запись — не ошибка формата,
    /// а «занято», поэтому докручиваем в цикле.
    pub fn write_all(&self, buf: &[u8]) -> io::Result<()> {
        let mut written = 0usize;
        while written < buf.len() {
            let mut n = 0u32;
            let ok = unsafe {
                WriteFile(
                    self.0,
                    buf[written..].as_ptr(),
                    (buf.len() - written) as u32,
                    &mut n,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 || n == 0 {
                return Err(io::Error::last_os_error());
            }
            written += n as usize;
        }
        Ok(())
    }

    /// Сколько байт уже лежит в буфере канала, не забирая их.
    /// Err — канал закрыт (дискорд перезапустился): это не ошибка, а повод
    /// переподключиться.
    pub fn available(&self) -> io::Result<u32> {
        let mut avail = 0u32;
        let ok = unsafe {
            PeekNamedPipe(self.0, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut())
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(avail)
    }

    /// Читает ровно `buf.len()` байт. Вызывается только когда
    /// [`Pipe::available`] сообщил, что данных достаточно.
    pub fn read_exact(&self, buf: &mut [u8]) -> io::Result<()> {
        let mut got = 0usize;
        while got < buf.len() {
            let mut n = 0u32;
            let ok = unsafe {
                ReadFile(
                    self.0,
                    buf[got..].as_mut_ptr(),
                    (buf.len() - got) as u32,
                    &mut n,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe закрыт"));
            }
            got += n as usize;
        }
        Ok(())
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Пауза без блокировки дескриптора: Sleep не трогает канал, в отличие от
/// ожидания на самом хендле, который бы съел буфер.
pub fn pause() {
    unsafe {
        Sleep(WAIT_POLL_MS);
    }
}

/// Есть ли хоть один живой канал discord. Пробуем все десять: тот, что
/// обслуживает клиент, откроется, остальные вернут ошибку.
pub fn first_available() -> io::Result<Pipe> {
    let mut last = None;
    for idx in 0..10u8 {
        match Pipe::open(idx) {
            Ok(p) => {
                /* в системе бывает несколько discord-ipc-*, и какой из них
                   обслуживает клиент — вопрос к самому discord. Пишем
                   номер: если канал открывается не тот, handshake будет
                   падать, а в логе без этого видно только «переподключается» */
                settings::log(&format!("[discord] открыт канал discord-ipc-{idx}"));
                return Ok(p);
            }
            Err(e) => last = Some(e),
        }
    }
    settings::log(&format!(
        "[discord] ни один канал discord-ipc-0..9 не открылся: {}",
        last.as_ref()
            .map(|e| e.to_string())
            .unwrap_or_else(|| "нет данных".into())
    ));
    Err(last.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "discord ipc: каналы не найдены")
    }))
}
