use std::{
    env, fs,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const MAIN_WINDOW_LABEL: &str = "main";
const MENU_OPEN_ID: &str = "open-mandate";
const MENU_QUIT_ID: &str = "quit-mandate";
const DEFAULT_SIDECAR_HOST: &str = "127.0.0.1";
const DESKTOP_HOST_ENV: &str = "MANDATE_DESKTOP_HOST";
const DESKTOP_PORT_ENV: &str = "MANDATE_DESKTOP_PORT";

#[derive(Clone)]
struct MandateSidecar {
    child: Arc<Mutex<Option<CommandChild>>>,
    host: String,
    port: u16,
}

impl MandateSidecar {
    fn new(host: String, port: u16) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            host,
            port,
        }
    }

    fn start(&self, app: &AppHandle) -> Result<(), String> {
        let port_arg = self.port.to_string();
        let command = app
            .shell()
            .sidecar("mandate")
            .map_err(|error| format!("failed to locate mandate sidecar: {error}"))?
            .args([
                "serve",
                "--host",
                self.host.as_str(),
                "--port",
                port_arg.as_str(),
            ])
            .env("PATH", desktop_path());

        let (mut rx, child) = command
            .spawn()
            .map_err(|error| format!("failed to start mandate sidecar: {error}"))?;

        if let Some(existing) = self
            .child
            .lock()
            .expect("sidecar lock poisoned")
            .replace(child)
        {
            if let Err(error) = existing.kill() {
                eprintln!("[mandate-desktop] failed to stop replaced sidecar: {error}");
            }
        }

        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        print!("{}", String::from_utf8_lossy(&bytes));
                    }
                    CommandEvent::Stderr(bytes) => {
                        eprint!("{}", String::from_utf8_lossy(&bytes));
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    fn kill(&self) {
        if let Some(child) = self.child.lock().expect("sidecar lock poisoned").take() {
            if let Err(error) = child.kill() {
                eprintln!("[mandate-desktop] failed to stop sidecar: {error}");
            }
        }
    }

    fn restart(&self, app: &AppHandle) -> Result<(), String> {
        let connect_host = sidecar_connect_host(&self.host);
        self.kill();
        if !wait_for_server_shutdown(&connect_host, self.port, Duration::from_secs(5)) {
            return Err("backend did not stop before restart timeout".into());
        }
        self.start(app)?;
        if !wait_for_server(&connect_host, self.port, Duration::from_secs(20)) {
            self.kill();
            return Err("backend did not become ready after restart".into());
        }
        Ok(())
    }
}

fn pick_unused_port(host: &str) -> std::io::Result<u16> {
    let listener = TcpListener::bind((host, 0))?;
    Ok(listener.local_addr()?.port())
}

fn select_sidecar_endpoint() -> Result<(String, u16), String> {
    let config = configured_sidecar_config()?;
    select_sidecar_endpoint_from_config(config)
}

fn select_sidecar_endpoint_from_config(config: SidecarConfig) -> Result<(String, u16), String> {
    let host = config
        .host
        .unwrap_or_else(|| DEFAULT_SIDECAR_HOST.to_string());
    match config.port {
        Some(port) => match ensure_configured_port_available(&host, port) {
            Ok(()) => Ok((host, port)),
            Err(error) => {
                eprintln!("[mandate-desktop] {error}; falling back to an automatic port");
                pick_available_endpoint(&host)
            }
        },
        None => pick_available_endpoint(&host),
    }
}

fn pick_available_endpoint(host: &str) -> Result<(String, u16), String> {
    match pick_unused_port(host) {
        Ok(port) => Ok((host.to_string(), port)),
        Err(error) if host != DEFAULT_SIDECAR_HOST => {
            eprintln!(
                "[mandate-desktop] could not bind automatic port on {host}: {error}; falling back to {DEFAULT_SIDECAR_HOST}"
            );
            pick_unused_port(DEFAULT_SIDECAR_HOST)
                .map(|port| (DEFAULT_SIDECAR_HOST.to_string(), port))
                .map_err(|error| format!("failed to pick Mandate port: {error}"))
        }
        Err(error) => Err(format!("failed to pick Mandate port: {error}")),
    }
}

#[derive(Debug)]
struct SidecarConfig {
    host: Option<String>,
    port: Option<u16>,
}

fn configured_sidecar_config() -> Result<SidecarConfig, String> {
    let mut config = SidecarConfig {
        host: None,
        port: None,
    };

    if let Some(raw) = env::var_os(DESKTOP_HOST_ENV) {
        config.host = parse_host_string(DESKTOP_HOST_ENV, &raw.to_string_lossy())?;
    }
    if let Some(raw) = env::var_os(DESKTOP_PORT_ENV) {
        config.port = parse_port_string(DESKTOP_PORT_ENV, &raw.to_string_lossy())?;
    }
    if config.host.is_some() && config.port.is_some() {
        return Ok(config);
    }

    let config_path = desktop_config_path();
    if !config_path.exists() {
        return Ok(config);
    }

    let text = fs::read_to_string(&config_path)
        .map_err(|error| format!("failed to read {}: {error}", config_path.display()))?;
    let file_json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("failed to parse {}: {error}", config_path.display()))?;

    let file_config = configured_sidecar_config_from_json(&file_json)?;
    Ok(SidecarConfig {
        host: config.host.or(file_config.host),
        port: config.port.or(file_config.port),
    })
}

fn configured_sidecar_config_from_json(
    config: &serde_json::Value,
) -> Result<SidecarConfig, String> {
    let host = match config.get("host") {
        Some(value) => parse_host_value("host", value)?,
        None => None,
    };
    let port = match config.get("port") {
        Some(value) => parse_port_value("port", value)?,
        None => None,
    };
    Ok(SidecarConfig { host, port })
}

fn parse_host_value(label: &str, value: &serde_json::Value) -> Result<Option<String>, String> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(raw) => parse_host_string(label, raw),
        _ => Err(format!("{label} must be a listen address")),
    }
}

fn desktop_config_path() -> PathBuf {
    resolve_data_dir().join("config.json")
}

fn resolve_data_dir() -> PathBuf {
    if let Some(raw) = env::var_os("MANDATE_DATA_DIR") {
        let raw = raw.to_string_lossy();
        if let Some(rest) = raw.strip_prefix("~/") {
            if let Some(home) = env::var_os("HOME") {
                return PathBuf::from(home).join(rest);
            }
        }
        return PathBuf::from(raw.as_ref());
    }
    let home = env::var_os("HOME").unwrap_or_else(|| ".".into());
    PathBuf::from(home).join(".mandate")
}

fn parse_port_value(label: &str, value: &serde_json::Value) -> Result<Option<u16>, String> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Number(number) => {
            let port = number
                .as_u64()
                .ok_or_else(|| format!("{label} must be an integer port"))?;
            parse_port_number(label, port)
        }
        serde_json::Value::String(raw) => parse_port_string(label, raw),
        _ => Err(format!("{label} must be a port number")),
    }
}

fn parse_port_string(label: &str, raw: &str) -> Result<Option<u16>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let port = trimmed
        .parse::<u64>()
        .map_err(|_| format!("{label} must be an integer port"))?;
    parse_port_number(label, port)
}

fn parse_port_number(label: &str, port: u64) -> Result<Option<u16>, String> {
    if port == 0 {
        return Ok(None);
    }
    if port > u16::MAX as u64 {
        return Err(format!(
            "{label} must be between 1 and 65535, or 0 for automatic"
        ));
    }
    Ok(Some(port as u16))
}

fn parse_host_string(_label: &str, raw: &str) -> Result<Option<String>, String> {
    let host = raw.trim();
    if host.is_empty() {
        return Ok(None);
    }
    Ok(Some(host.to_string()))
}

fn sidecar_connect_host(host: &str) -> String {
    match host {
        "0.0.0.0" => "127.0.0.1".to_string(),
        "::" => "::1".to_string(),
        _ => host.to_string(),
    }
}

fn sidecar_client_host(host: &str) -> String {
    sidecar_connect_host(host)
}

fn host_for_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn ensure_configured_port_available(host: &str, port: u16) -> Result<(), String> {
    TcpListener::bind((host, port))
        .map(|_| ())
        .map_err(|error| {
            format!("configured Mandate sidecar address {host}:{port} is not available: {error}")
        })
}

fn wait_for_server(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect((host, port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn wait_for_server_shutdown(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect((host, port)).is_err() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn desktop_path() -> String {
    let mut paths = vec![
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin",
        "/opt/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();

    if let Some(home) = env::var_os("HOME") {
        let home = home.to_string_lossy();
        paths.push(format!("{home}/.local/bin"));
        paths.push(format!("{home}/.cargo/bin"));
    }

    if let Some(existing) = env::var_os("PATH") {
        for path in env::split_paths(&existing) {
            let path = path.to_string_lossy().into_owned();
            if !paths.iter().any(|existing| existing == &path) {
                paths.push(path);
            }
        }
    }

    paths.join(":")
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.show() {
        eprintln!("[mandate-desktop] failed to show app: {error}");
    }

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(error) = window.show() {
            eprintln!("[mandate-desktop] failed to show window: {error}");
        }
        if let Err(error) = window.set_focus() {
            eprintln!("[mandate-desktop] failed to focus window: {error}");
        }
    }
}

fn desktop_init_script(host: &str, port: u16) -> String {
    let host = host_for_url(&sidecar_client_host(host));
    format!(
        r#"window.__MANDATE_DESKTOP__ = Object.freeze({{
  apiBaseUrl: "http://{host}:{port}"
}});"#
    )
}

fn draw_pixel(rgba: &mut [u8], width: u32, height: u32, x: i32, y: i32) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }

    let index = ((y as u32 * width + x as u32) * 4) as usize;
    rgba[index] = 0;
    rgba[index + 1] = 0;
    rgba[index + 2] = 0;
    rgba[index + 3] = 255;
}

fn draw_brush(rgba: &mut [u8], width: u32, height: u32, x: i32, y: i32, radius: i32) {
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if dx * dx + dy * dy <= radius * radius {
                draw_pixel(rgba, width, height, x + dx, y + dy);
            }
        }
    }
}

fn draw_line(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    start: (i32, i32),
    end: (i32, i32),
    radius: i32,
) {
    let (mut x0, mut y0) = start;
    let (x1, y1) = end;
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;

    loop {
        draw_brush(rgba, width, height, x0, y0, radius);
        if x0 == x1 && y0 == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x0 += sx;
        }
        if e2 <= dx {
            err += dx;
            y0 += sy;
        }
    }
}

fn tray_template_icon() -> Image<'static> {
    const WIDTH: u32 = 32;
    const HEIGHT: u32 = 32;
    let mut rgba = vec![0; (WIDTH * HEIGHT * 4) as usize];

    // Transparent macOS template icon: only alpha matters. Keep this much
    // simpler than the full app icon so it reads cleanly in the 18px status bar.
    for &(start, end, radius) in &[
        ((6, 25), (6, 8), 2),
        ((6, 8), (14, 19), 2),
        ((14, 19), (16, 13), 2),
        ((16, 13), (18, 19), 2),
        ((18, 19), (26, 8), 2),
        ((26, 8), (26, 25), 2),
    ] {
        draw_line(&mut rgba, WIDTH, HEIGHT, start, end, radius);
    }

    Image::new_owned(rgba, WIDTH, HEIGHT)
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN_ID, "Open Mandate", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT_ID, "Quit Mandate", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Mandate")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN_ID => show_main_window(app),
            MENU_QUIT_ID => {
                let sidecar = app.state::<MandateSidecar>();
                sidecar.kill();
                app.exit(0);
            }
            _ => {}
        });

    tray = tray.icon(tray_template_icon()).icon_as_template(true);

    tray.build(app)?;
    Ok(())
}

#[tauri::command]
async fn restart_backend(
    app: AppHandle,
    sidecar: tauri::State<'_, MandateSidecar>,
) -> Result<(), String> {
    let sidecar = sidecar.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sidecar.restart(&app))
        .await
        .map_err(|error| format!("backend restart task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![restart_backend])
        .setup(|app| {
            let (host, port) = select_sidecar_endpoint()?;
            let connect_host = sidecar_connect_host(&host);
            let sidecar = MandateSidecar::new(host.clone(), port);
            sidecar.start(app.handle())?;
            app.manage(sidecar);
            install_tray(app)?;

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                if !wait_for_server(&connect_host, port, Duration::from_secs(20)) {
                    eprintln!("[mandate-desktop] mandate sidecar did not become ready");
                    return;
                }

                let window_builder = WebviewWindowBuilder::new(
                    &app_handle,
                    MAIN_WINDOW_LABEL,
                    WebviewUrl::App("index.html".into()),
                )
                .title("Mandate")
                .inner_size(1280.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .initialization_script(desktop_init_script(&connect_host, port));

                #[cfg(target_os = "macos")]
                let window_builder = window_builder.hidden_title(true);

                let window_result = window_builder.build();

                if let Err(error) = window_result {
                    eprintln!("[mandate-desktop] failed to create window: {error}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("[mandate-desktop] failed to hide window: {error}");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Mandate desktop app");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let sidecar = app_handle.state::<MandateSidecar>();
            sidecar.kill();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main_window(app_handle),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn configured_sidecar_config_reads_top_level_host_and_port() {
        let config = json!({ "host": "0.0.0.0", "port": 4777 });
        let parsed = configured_sidecar_config_from_json(&config).unwrap();
        assert_eq!(parsed.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(parsed.port, Some(4777));
    }

    #[test]
    fn configured_sidecar_config_allows_zero_port_for_automatic() {
        let config = json!({ "port": 0 });
        let parsed = configured_sidecar_config_from_json(&config).unwrap();
        assert_eq!(parsed.host, None);
        assert_eq!(parsed.port, None);
    }

    #[test]
    fn configured_sidecar_config_rejects_invalid_ports() {
        let config = json!({ "port": 70000 });
        let error = configured_sidecar_config_from_json(&config).unwrap_err();
        assert!(error.contains("between 1 and 65535"));
    }

    #[test]
    fn sidecar_endpoint_falls_back_when_configured_port_is_busy() {
        let listener = TcpListener::bind((DEFAULT_SIDECAR_HOST, 0)).unwrap();
        let busy_port = listener.local_addr().unwrap().port();
        let (host, port) = select_sidecar_endpoint_from_config(SidecarConfig {
            host: Some(DEFAULT_SIDECAR_HOST.to_string()),
            port: Some(busy_port),
        })
        .unwrap();

        assert_eq!(host, DEFAULT_SIDECAR_HOST);
        assert_ne!(port, busy_port);
    }
}
