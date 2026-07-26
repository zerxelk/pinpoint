use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

// Holds the backend sidecar's child handle so it can be reaped on app exit.
// Tauri's CommandChild does nothing on drop, so without this the backend
// outlives the app as an orphan whenever quit skips the window's JS cleanup
// (Cmd+Q and Dock > Quit both bypass onCloseRequested entirely).
struct BackendProcess(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let sidecar = app
                .shell()
                .sidecar("mirage-backend")
                .expect("failed to create backend sidecar");
            let (mut rx, child) = sidecar.spawn().expect("failed to spawn backend");
            *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line) = event {
                        println!("[backend] {}", String::from_utf8_lossy(&line));
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let child = app_handle.state::<BackendProcess>().0.lock().unwrap().take();
                if let Some(child) = child {
                    let pid = child.pid();
                    // SIGTERM first so the backend's own signal handler can revert an
                    // active GPS spoof before exiting; a bare SIGKILL would skip that
                    // and leave the phone stuck spoofed. Give it a moment, then make
                    // sure it's actually gone.
                    let _ = std::process::Command::new("kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = child.kill();
                }
            }
        });
}
