// Keep a console window from opening next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    junior_desktop_lib::run();
}
