#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tokio::sync::Mutex;
use war_thunder_telemetry::{TelemetryClient, Snapshot};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use std::io::Write;
struct SmokeMode(bool);
#[tauri::command]
async fn datamine_bootstrap(window:WebviewWindow,updater:tauri::State<'_,Mutex<datamine_updater::Updater>>)->Result<datamine_updater::DataSnapshot,String>{
    require_main(&window)?;Ok(updater.lock().await.snapshot())
}
#[tauri::command]
async fn datamine_check(window:WebviewWindow,updater:tauri::State<'_,Mutex<datamine_updater::Updater>>,smoke:tauri::State<'_,SmokeMode>)->Result<datamine_updater::UpdateResult,String>{
    require_main(&window)?;
    if smoke.0 { return Err("Automatic downloads are disabled during the isolated native test".into()); }
    updater.lock().await.check().await
}
fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("This action is available in the main window only".into()); }
    Ok(())
}
#[tauri::command]
async fn telemetry_snapshot(window: WebviewWindow, client: tauri::State<'_, Mutex<TelemetryClient>>) -> Result<Snapshot,String> {
    require_main(&window)?;
    Ok(client.lock().await.snapshot().await)
}
#[tauri::command]
fn export_json(window: WebviewWindow, app: tauri::AppHandle, kind: String, content: String) -> Result<String,String> {
    require_main(&window)?;
    if !["battle", "diagnostics"].contains(&kind.as_str()) || content.len() > 2*1024*1024 { return Err("Invalid export".into()); }
    let directory=app.path().download_dir().map_err(|e|e.to_string())?;
    let path=directory.join(format!("nuclear-thunder-{}-{}.json",kind,war_thunder_telemetry::now_ms()));
    let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(|e|e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e|e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
#[tauri::command]
async fn open_overlay(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_main(&window)?;
    let smoke = app.state::<SmokeMode>().0;
    if let Some(overlay) = app.get_webview_window("overlay") {
        // Reopening is also the recovery path from click-through mode.
        overlay.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
        if !smoke { overlay.show().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("index.html?overlay=1".into()))
        .title("Nuclear Thunder Live — nearby map")
        .inner_size(400.0, 400.0)
        .min_inner_size(280.0, 280.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(true)
        .focused(false)
        .visible(!smoke)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn close_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn configure_overlay(window: WebviewWindow, app: tauri::AppHandle, click_through: bool) -> Result<(), String> {
    require_main(&window)?;
    let overlay = app.get_webview_window("overlay").ok_or("Open the nearby map first")?;
    overlay.set_ignore_cursor_events(click_through).map_err(|e| e.to_string())
}
#[tauri::command]
fn native_smoke_complete(window: WebviewWindow, app: tauri::AppHandle, smoke: tauri::State<SmokeMode>, mut report: serde_json::Value) -> Result<(),String> {
    require_main(&window)?;
    if !smoke.0 { return Err("Smoke reporting is disabled in normal operation".into()); }
    if let Some(overlay) = app.get_webview_window("overlay") {
        report["overlayWindow"] = serde_json::json!({"created":true,"alwaysOnTop":overlay.is_always_on_top().unwrap_or(false),"decorated":overlay.is_decorated().unwrap_or(true),"visible":overlay.is_visible().unwrap_or(true)});
        if report["overlayWindow"]["alwaysOnTop"] != true || report["overlayWindow"]["decorated"] != false { report["success"] = false.into(); }
    } else { report["success"] = false.into(); }
    let directory=std::env::current_dir().map_err(|e|e.to_string())?.join("docs/verification");
    std::fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    std::fs::write(directory.join("native-smoke.json"),serde_json::to_vec_pretty(&report).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    app.exit(if report["success"]==true {0}else{1});Ok(())
}
fn main() {
    let smoke=std::env::args().any(|a|a=="--smoke-test");
    tauri::Builder::default()
        .manage(SmokeMode(smoke))
        .manage(Mutex::new(TelemetryClient::new().expect("HTTP client initialization failed")))
        .setup(move |app| {
            let directory=if smoke{std::env::current_dir()?.join(".local/native-smoke-data")}else{app.path().app_local_data_dir()?.join("datamine-v1")};
            let lock:serde_json::Value=serde_json::from_str(include_str!("../../../web/public/datamine-lock.json"))?;
            app.manage(Mutex::new(datamine_updater::Updater::new(directory,lock["accepted_commit"].as_str().unwrap_or("bundled").into()).map_err(std::io::Error::other)?));
            if smoke { if let Some(window)=app.get_webview_window("main"){window.hide()?;} let handle=app.handle().clone();tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_secs(45)).await;handle.exit(2);}); } Ok(()) })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(overlay) = window.app_handle().get_webview_window("overlay") {
                    let _ = overlay.close();
                }
                window.app_handle().exit(0);
            }
        })
        .on_page_load(move |webview,payload| {
            if smoke && webview.label() == "main" && matches!(payload.event(),tauri::webview::PageLoadEvent::Finished) {
                let _=webview.eval(include_str!("smoke.js"));
            }
            if smoke && webview.label() == "overlay" && matches!(payload.event(),tauri::webview::PageLoadEvent::Finished) {
                let _=webview.eval(include_str!("overlay-smoke.js"));
            }
        })
        .invoke_handler(tauri::generate_handler![telemetry_snapshot, export_json, native_smoke_complete, open_overlay, close_overlay, configure_overlay, datamine_bootstrap, datamine_check])
        .run(tauri::generate_context!()).expect("Unable to start Nuclear Thunder Live");
}
