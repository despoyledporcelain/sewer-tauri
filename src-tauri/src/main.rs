// seWer — вход в бинарь. Вся логика в библиотеке, чтобы её можно было
// покрыть тестами и вызывать из rust-тестов без запуска gui.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sewer_tauri_lib::run()
}
