// Hide the extra console window that Windows would otherwise attach to a
// release build. No effect on macOS or Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    winnow_lib::run()
}
