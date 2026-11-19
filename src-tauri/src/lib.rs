use std::{
    collections::VecDeque,
    env, fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use tauri::{
    image::Image,
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const MAIN_WINDOW_LABEL: &str = "main";
const MENU_OPEN_ID: &str = "open-mandate";
const MENU_QUIT_ID: &str = "quit-mandate";
const DEFAULT_SIDECAR_HOST: &str = "127.0.0.1";

#[derive(Clone)]
struct MandateSidecar {
    child: Arc<Mutex<Option<CommandChild>>>,
    host: String,
    port: u16,
    /// Set right before we kill the child ourselves (quit, restart, replace),
    /// so its Terminated event is not mistaken for a crash.
    expected_exit: Arc<AtomicBool>,
    /// When the sidecar died on its own, within the crash window.
    crashes: Arc<Mutex<Vec<Instant>>>,
    /// The last lines the sidecar printed, for the "Show log" dialog.
    log: Arc<Mutex<VecDeque<String>>>,
    /// The last status reported, for a page that loads after it was sent.
    status: Arc<Mutex<BackendStatus>>,
    /// How many statuses have been reported, so a restart can tell one
    /// reported during it from the one it started on.
    reports: Arc<AtomicU64>,
}

/// Event the webview listens for; payload is a `BackendStatus`.
const BACKEND_EVENT: &str = "mandate:backend";
const BACKEND_LOG_LINES: usize = 200;
/// Unexpected exits are restarted automatically up to this many times within
/// `CRASH_WINDOW`; after that the shell stops trying and hands it to the user.
const CRASH_LIMIT: usize = 3;
const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// How `mandate serve` exits when another server holds its data directory
/// (DATA_DIR_IN_USE_EXIT_CODE in src/server/app/data-dir-in-use.ts): not a
/// crash, so it is shown, not restarted into the same refusal.
const DATA_DIR_IN_USE_EXIT: i32 = 75;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum BackendStatus {
    Running,
    Restarting {
        attempt: usize,
        code: Option<i32>,
    },
    Stopped {
        attempts: usize,
        code: Option<i32>,
    },
    /// Another server holds the data directory; `url` is where it says it
    /// listens, when it says so.
    #[serde(rename = "in_use")]
    InUse {
        url: Option<String>,
    },
}

fn emit_backend_status(app: &AppHandle, status: BackendStatus) {
    if let Err(error) = app.emit(BACKEND_EVENT, status) {
        eprintln!("[mandate-desktop] backend status event failed: {error}");
    }
}

impl MandateSidecar {
    fn new(host: String, port: u16) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            host,
            port,
            expected_exit: Arc::new(AtomicBool::new(false)),
            crashes: Arc::new(Mutex::new(Vec::new())),
            log: Arc::new(Mutex::new(VecDeque::with_capacity(BACKEND_LOG_LINES))),
            status: Arc::new(Mutex::new(BackendStatus::Running)),
            reports: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Keeps the status for `backend_status` and tells the page.
    fn report(&self, app: &AppHandle, status: BackendStatus) {
        {
            let mut slot = self.status.lock().expect("sidecar status poisoned");
            *slot = status.clone();
            self.reports.fetch_add(1, Ordering::SeqCst);
        }
        emit_backend_status(app, status);
    }

    fn reports(&self) -> u64 {
        self.reports.load(Ordering::SeqCst)
    }

    fn status(&self) -> BackendStatus {
        self.status.lock().expect("sidecar status poisoned").clone()
    }

    fn stopped(&self) -> bool {
        matches!(
            self.status(),
            BackendStatus::Stopped { .. } | BackendStatus::InUse { .. }
        )
    }

    /// Starts the sidecar; the new child's pid.
    fn start(&self, app: &AppHandle) -> Result<u32, String> {
        let port_arg = self.port.to_string();
        // The sidecar watches this pid and shuts down when we are gone, so a
        // crashed or force-quit shell leaves no server holding the port.
        let parent_pid = std::process::id().to_string();
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
                "--parent-pid",
                parent_pid.as_str(),
            ])
            .env("PATH", desktop_path());

        let (mut rx, child) = command
            .spawn()
            .map_err(|error| format!("failed to start mandate sidecar: {error}"))?;
        let pid = child.pid();

        if let Some(existing) = self
            .child
            .lock()
            .expect("sidecar lock poisoned")
            .replace(child)
        {
            self.expected_exit.store(true, Ordering::SeqCst);
            if let Err(error) = existing.kill() {
                eprintln!("[mandate-desktop] failed to stop replaced sidecar: {error}");
            }
        }

        let sidecar = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        let text = String::from_utf8_lossy(&bytes);
                        print!("{text}");
                        sidecar.remember_log(&text);
                    }
                    CommandEvent::Stderr(bytes) => {
                        let text = String::from_utf8_lossy(&bytes);
                        eprint!("{text}");
                        sidecar.remember_log(&text);
                    }
                    CommandEvent::Terminated(payload) => {
                        // Drop our own dead handle, and only our own: after a
                        // restart the slot may already hold the replacement.
                        // Leaving a dead handle in place made the next start()
                        // "replace" it, flag that as an expected exit, and so
                        // ignore the replacement's real crash (seen once).
                        {
                            let mut slot = sidecar.child.lock().expect("sidecar lock poisoned");
                            if slot.as_ref().map(|c| c.pid()) == Some(pid) {
                                slot.take();
                            }
                        }
                        if sidecar.expected_exit.swap(false, Ordering::SeqCst) {
                            break;
                        }
                        if let Some(status) = in_use_status(payload.code, &resolve_data_dir()) {
                            eprintln!("[mandate-desktop] another Mandate server is using the data directory; not restarting");
                            sidecar.report(&app, status);
                            break;
                        }
                        sidecar.on_unexpected_exit(&app, payload.code);
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(pid)
    }

    fn remember_log(&self, text: &str) {
        let mut log = self.log.lock().expect("sidecar log poisoned");
        for line in text.lines() {
            if log.len() == BACKEND_LOG_LINES {
                log.pop_front();
            }
            log.push_back(line.to_string());
        }
    }

    fn recent_log(&self) -> Vec<String> {
        self.log
            .lock()
            .expect("sidecar log poisoned")
            .iter()
            .cloned()
            .collect()
    }

    /// The sidecar died without us asking. Restart it, up to `CRASH_LIMIT`
    /// times per `CRASH_WINDOW`; past that, report Stopped and wait for the
    /// user's Restart. Runs the restart off the event thread.
    fn on_unexpected_exit(&self, app: &AppHandle, code: Option<i32>) {
        let attempt = {
            let mut crashes = self.crashes.lock().expect("sidecar crashes poisoned");
            let now = Instant::now();
            crashes.retain(|at| now.duration_since(*at) < CRASH_WINDOW);
            crashes.push(now);
            crashes.len()
        };
        if attempt > CRASH_LIMIT {
            eprintln!("[mandate-desktop] sidecar exited unexpectedly (code {code:?}) again; giving up after {CRASH_LIMIT} restarts in {}s", CRASH_WINDOW.as_secs());
            self.report(
                app,
                BackendStatus::Stopped {
                    attempts: CRASH_LIMIT,
                    code,
                },
            );
            return;
        }
        eprintln!("[mandate-desktop] sidecar exited unexpectedly (code {code:?}); restart {attempt}/{CRASH_LIMIT}");
        self.report(app, BackendStatus::Restarting { attempt, code });
        let sidecar = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            let connect_host = sidecar_connect_host(&sidecar.host);
            let stopped = BackendStatus::Stopped {
                attempts: attempt,
                code,
            };
            let Ok(pid) = sidecar.start(&app) else {
                sidecar.report(&app, stopped);
                return;
            };
            // Over as soon as its child is gone or replaced (a crash that
            // brings the next attempt, the user's Restart): then the child
            // now in the slot is another's to judge.
            let ready = wait_until_ready_or_stopped(
                &connect_host,
                sidecar.port,
                Duration::from_secs(20),
                || sidecar.current_pid() != Some(pid),
            );
            match restart_verdict(ready, sidecar.current_pid() == Some(pid)) {
                RestartVerdict::Superseded => {}
                RestartVerdict::Running => sidecar.report(&app, BackendStatus::Running),
                RestartVerdict::Stopped => {
                    if sidecar.kill_if_current(pid) {
                        sidecar.report(&app, stopped);
                    }
                }
            }
        });
    }

    /// The pid of the child in the slot, if one is there.
    fn current_pid(&self) -> Option<u32> {
        self.child
            .lock()
            .expect("sidecar lock poisoned")
            .as_ref()
            .map(|child| child.pid())
    }

    /// Kills the child in the slot only while it is still `pid`; whether it
    /// did. A restart's thread that outlived its child never takes a newer
    /// one.
    fn kill_if_current(&self, pid: u32) -> bool {
        let mut slot = self.child.lock().expect("sidecar lock poisoned");
        if slot.as_ref().map(|child| child.pid()) != Some(pid) {
            return false;
        }
        if let Some(child) = slot.take() {
            self.expected_exit.store(true, Ordering::SeqCst);
            if let Err(error) = child.kill() {
                eprintln!("[mandate-desktop] failed to stop sidecar: {error}");
            }
        }
        true
    }

    fn kill(&self) {
        if let Some(child) = self.child.lock().expect("sidecar lock poisoned").take() {
            self.expected_exit.store(true, Ordering::SeqCst);
            if let Err(error) = child.kill() {
                eprintln!("[mandate-desktop] failed to stop sidecar: {error}");
            }
        }
    }

    fn restart(&self, app: &AppHandle) -> Result<(), String> {
        let connect_host = sidecar_connect_host(&self.host);
        let before = self.status();
        self.kill();
        if !wait_for_server_shutdown(&connect_host, self.port, Duration::from_secs(5)) {
            return Err("backend did not stop before restart timeout".into());
        }
        let since = self.reports();
        let pid = match self.start(app) {
            Ok(pid) => pid,
            Err(error) => {
                self.report(app, failed_restart_status(&before));
                return Err(error);
            }
        };
        if wait_until_ready_or_stopped(&connect_host, self.port, Duration::from_secs(20), || {
            restart_given_up(since, self.reports(), &self.status())
        }) {
            return Ok(());
        }
        // A child killed here reports nothing of its own: say this attempt
        // failed, so the status it started on (another server holding the
        // directory) is not shown as the reason. A child no longer in the
        // slot has been, or will be, reported by its own exit or retry.
        if self.kill_if_current(pid) {
            self.report(app, failed_restart_status(&before));
        }
        Err("backend did not become ready after restart".into())
    }
}

/// Whether a user's restart is over before its server answers: only once
/// the shell has reported a stop since it began (its child refused the data
/// directory, or the shell's own retries after a crash gave up). The status
/// it started on is not its own, and a crash still being retried is waited
/// for.
fn restart_given_up(reports_at_start: u64, reports_now: u64, status: &BackendStatus) -> bool {
    reports_now != reports_at_start
        && matches!(
            status,
            BackendStatus::Stopped { .. } | BackendStatus::InUse { .. }
        )
}

/// The status after a user's restart failed with nothing else said: stopped,
/// one attempt on from the stop it was pressed on.
fn failed_restart_status(before: &BackendStatus) -> BackendStatus {
    let attempts = match before {
        BackendStatus::Stopped { attempts, .. } => attempts + 1,
        _ => 1,
    };
    BackendStatus::Stopped {
        attempts,
        code: None,
    }
}

/// The status for a sidecar that exited with `code`, when that exit says
/// another server holds the data directory: with that server's address, as
/// its own server.json names it, while that server is still there.
fn in_use_status(code: Option<i32>, data_dir: &Path) -> Option<BackendStatus> {
    (code == Some(DATA_DIR_IN_USE_EXIT)).then(|| BackendStatus::InUse {
        url: running_server_url(data_dir),
    })
}

fn running_server_url(data_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(data_dir.join("server.json")).ok()?;
    let address: serde_json::Value = serde_json::from_str(&text).ok()?;
    let pid = address.get("pid")?.as_i64()?;
    // A record a crashed server left behind names nobody to open.
    if !process_exists(pid) {
        return None;
    }
    address.get("url")?.as_str().map(str::to_string)
}

/// Whether a process with this pid exists: signal 0 checks without
/// signalling, and EPERM means it exists but is not ours.
fn process_exists(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    alive || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn pick_unused_port(host: &str) -> std::io::Result<u16> {
    let listener = TcpListener::bind((host, 0))?;
    Ok(listener.local_addr()?.port())
}

fn select_sidecar_endpoint() -> Result<(String, u16), String> {
    select_sidecar_endpoint_from_config(sidecar_config_or_automatic(&desktop_config_path()))
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

/// The host and port config.json gives; a file the shell cannot read leaves
/// both to it (it picks a port), and the sidecar, reading the same file, says
/// what is wrong with it.
fn sidecar_config_or_automatic(config_path: &Path) -> SidecarConfig {
    sidecar_config_at(config_path).unwrap_or_else(|error| {
        eprintln!("[mandate-desktop] {error}; picking a port, the server reports the file");
        SidecarConfig {
            host: None,
            port: None,
        }
    })
}

/// The host and port config.json gives, which the shell passes to the
/// sidecar as flags; neither when there is no file.
fn sidecar_config_at(config_path: &Path) -> Result<SidecarConfig, String> {
    if !config_path.exists() {
        return Ok(SidecarConfig {
            host: None,
            port: None,
        });
    }

    let text = fs::read_to_string(config_path)
        .map_err(|error| format!("failed to read {}: {error}", config_path.display()))?;
    let file_json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("failed to parse {}: {error}", config_path.display()))?;

    configured_sidecar_config_from_json(&file_json)
        .map_err(|error| format!("{}: {error}", config_path.display()))
}

/// config.json keeps the server's address under `server`.
fn configured_sidecar_config_from_json(
    config: &serde_json::Value,
) -> Result<SidecarConfig, String> {
    let server = config.get("server");
    let host = match server.and_then(|server| server.get("host")) {
        Some(value) => parse_host_value("server.host", value)?,
        None => None,
    };
    let port = match server.and_then(|server| server.get("port")) {
        Some(value) => parse_port_value("server.port", value)?,
        None => None,
    };
    Ok(SidecarConfig { host, port })
}

fn parse_host_value(label: &str, value: &serde_json::Value) -> Result<Option<String>, String> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(raw) => parse_host_string(raw),
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
        _ => Err(format!("{label} must be a port number")),
    }
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

fn parse_host_string(raw: &str) -> Result<Option<String>, String> {
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

/// What an automatic restart's thread does once its wait is over: nothing
/// when the slot no longer holds its child (another start owns the verdict),
/// else report the child running, or stop it.
enum RestartVerdict {
    Superseded,
    Running,
    Stopped,
}

fn restart_verdict(ready: bool, still_ours: bool) -> RestartVerdict {
    match (still_ours, ready) {
        (false, _) => RestartVerdict::Superseded,
        (true, true) => RestartVerdict::Running,
        (true, false) => RestartVerdict::Stopped,
    }
}

/// Whether the server answers within `timeout`; over as soon as `stopped`
/// says the sidecar gave up (a server that cannot start ends long before the
/// timeout).
fn wait_until_ready_or_stopped(
    host: &str,
    port: u16,
    timeout: Duration,
    stopped: impl Fn() -> bool,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if stopped() {
            return false;
        }
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

/// ⌘W / the close button: the app lives in the tray, so the window hides
/// instead of closing. A macOS fullscreen window cannot simply be hidden —
/// its Space stays behind as a black screen until the user leaves it by
/// hand — so leave fullscreen first and hide once the transition is over.
fn hide_to_tray(window: tauri::Window) {
    save_window_state(window.app_handle());
    if window.is_fullscreen().unwrap_or(false) {
        if let Err(error) = window.set_fullscreen(false) {
            eprintln!("[mandate-desktop] failed to leave fullscreen: {error}");
        }
        thread::spawn(move || {
            // The leave-fullscreen animation takes ~0.6s; `is_fullscreen`
            // flips early in it, so wait for the flip and then some.
            for _ in 0..40 {
                thread::sleep(Duration::from_millis(50));
                if !window.is_fullscreen().unwrap_or(true) {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(700));
            if let Err(error) = window.hide() {
                eprintln!("[mandate-desktop] failed to hide window: {error}");
            }
        });
        return;
    }
    if let Err(error) = window.hide() {
        eprintln!("[mandate-desktop] failed to hide window: {error}");
    }
}

/// `--panel` of the theme the system is in: dark #1e1e21, light #f5f5f7.
fn first_frame_color() -> tauri::window::Color {
    if system_prefers_dark() {
        tauri::window::Color(0x1e, 0x1e, 0x21, 0xff)
    } else {
        tauri::window::Color(0xf5, 0xf5, 0xf7, 0xff)
    }
}

/// macOS appearance, read the way the system exposes it to scripts: the
/// global default `AppleInterfaceStyle` is "Dark" in dark mode and absent
/// (the command fails) in light mode.
#[cfg(target_os = "macos")]
fn system_prefers_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|out| {
            out.status.success()
                && String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .eq_ignore_ascii_case("dark")
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn system_prefers_dark() -> bool {
    true
}

const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

fn save_window_state(app: &AppHandle) {
    if let Err(error) = app.save_window_state(WINDOW_STATE_FLAGS) {
        eprintln!("[mandate-desktop] failed to save window state: {error}");
    }
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
    let host = host_for_url(&sidecar_connect_host(host));
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

const ZOOM_IN_ID: &str = "zoom-in";
const ZOOM_OUT_ID: &str = "zoom-out";
const ZOOM_RESET_ID: &str = "zoom-reset";
/// Event the webview listens for; payload is "in" / "out" / "reset".
const ZOOM_EVENT: &str = "mandate:zoom";
const REOPEN_TAB_ID: &str = "reopen-closed-tab";
/// Event the webview listens for: the right panel in sight reopens its
/// latest closed tab (lib/reopen-closed-tab.ts). A browser keeps ⌘⇧T for its
/// own tabs, so only the app has it.
const REOPEN_TAB_EVENT: &str = "mandate:reopen-closed-tab";

/// The macOS menu bar: Tauri's default menu with a View submenu that carries
/// interface zoom (Zoom In ⌘=, Zoom Out ⌘−, Actual Size ⌘0) ahead of the
/// fullscreen toggle. The accelerators are what make ⌘= / ⌘− / ⌘0 work
/// system-wide in the app; the items only emit an event, the webview owns the
/// factor (lib/desktop-zoom.ts) and remembers it. File carries Reopen Closed
/// Tab (⌘⇧T), which only emits as well.
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let handle = app.handle();
    let pkg = handle.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        handle,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(
                handle,
                REOPEN_TAB_ID,
                "Reopen Closed Tab",
                true,
                Some("CmdOrCtrl+Shift+T"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &MenuItem::with_id(handle, ZOOM_IN_ID, "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(handle, ZOOM_OUT_ID, "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(
                handle,
                ZOOM_RESET_ID,
                "Actual Size",
                true,
                Some("CmdOrCtrl+0"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;
    Menu::with_items(
        handle,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

fn zoom_direction(id: &str) -> Option<&'static str> {
    match id {
        ZOOM_IN_ID => Some("in"),
        ZOOM_OUT_ID => Some("out"),
        ZOOM_RESET_ID => Some("reset"),
        _ => None,
    }
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
    let reporter = sidecar.clone();
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || sidecar.restart(&app))
        .await
        .map_err(|error| format!("backend restart task failed: {error}"))?;
    if result.is_ok() {
        reporter.report(&handle, BackendStatus::Running);
    }
    result
}

/// The last status reported: a page that loads after a status was sent
/// (the server stopped before the window opened) asks for it.
#[tauri::command]
fn backend_status(sidecar: tauri::State<'_, MandateSidecar>) -> BackendStatus {
    sidecar.status()
}

/// The last lines the sidecar printed (stdout and stderr, in order).
#[tauri::command]
fn backend_log(sidecar: tauri::State<'_, MandateSidecar>) -> Vec<String> {
    sidecar.recent_log()
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
        // Mandate's notices as native notifications; the page shows them and
        // hears their clicks.
        .plugin(tauri_plugin_notification::init())
        // Size, position and maximized state persist per machine: the plugin
        // restores them when the window is ready and tracks moves/resizes; we
        // save on hide-to-tray and on quit. Fullscreen is left out on purpose:
        // the app reopens as a normal window, like a native one.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            restart_backend,
            backend_log,
            backend_status
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(direction) = zoom_direction(id) {
                if let Err(error) = app.emit(ZOOM_EVENT, direction) {
                    eprintln!("[mandate-desktop] zoom event failed: {error}");
                }
            } else if id == REOPEN_TAB_ID {
                if let Err(error) = app.emit(REOPEN_TAB_EVENT, ()) {
                    eprintln!("[mandate-desktop] reopen tab event failed: {error}");
                }
            }
        })
        .setup(|app| {
            let (host, port) = select_sidecar_endpoint()?;
            let connect_host = sidecar_connect_host(&host);
            let sidecar = MandateSidecar::new(host.clone(), port);
            sidecar.start(app.handle())?;
            let watched = sidecar.clone();
            app.manage(sidecar);
            install_tray(app)?;
            #[cfg(target_os = "macos")]
            app.set_menu(build_app_menu(app)?)?;

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                // The window opens either way: one whose server stopped at
                // start shows the banner and its log.
                if !wait_until_ready_or_stopped(
                    &connect_host,
                    port,
                    Duration::from_secs(20),
                    || watched.stopped(),
                ) {
                    eprintln!("[mandate-desktop] mandate sidecar did not become ready");
                }

                let opener = app_handle.clone();
                let window_builder = WebviewWindowBuilder::new(
                    &app_handle,
                    MAIN_WINDOW_LABEL,
                    WebviewUrl::App("index.html".into()),
                )
                .title("Mandate")
                .inner_size(1280.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .initialization_script(desktop_init_script(&connect_host, port))
                // The webview drops a request for a new window unless it is
                // handled here: see external_browser_url.
                .on_new_window(move |url, _features| {
                    if let Some(address) = external_browser_url(&url) {
                        if let Err(error) = opener.opener().open_url(address, None::<&str>) {
                            eprintln!("[mandate-desktop] failed to open {address}: {error}");
                        }
                    }
                    NewWindowResponse::Deny
                });

                // Overlay title bar: the web UI draws under the traffic lights and
                // gives them a 28px strip (shell/TitlebarStrip.tsx) above each
                // column, the height of a standard title bar. The inset is not
                // the lights' top edge: measured on screenshots across three
                // values, the visible circles' centre sits at y - 4 (the
                // accessibility API's 16px button frames are not centred on the
                // circles, so they mislead by 2px). y = 20 puts the centre at 16,
                // 2px below the strip's middle, where they are meant to sit; x = 14 lands them at 15, level with the sidebar's
                // brand mark.
                // The background colour is the --panel token of the theme that
                // will show, so the first frame is the sidebar's colour and not
                // a flash of the other theme. The shell cannot read the page's
                // own preference, so it follows the system appearance — right
                // for the default (System) and for whoever's explicit choice
                // matches it; a test pins both values to the stylesheet.
                #[cfg(target_os = "macos")]
                let window_builder = window_builder
                    .hidden_title(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .traffic_light_position(tauri::LogicalPosition::new(14.0, 20.0))
                    .background_color(first_frame_color());

                // The window-state plugin restores the remembered geometry
                // itself when the window is ready (its on_window_ready hook),
                // before the first paint. Do NOT also call restore_state here:
                // the hook and an explicit call from this thread deadlock on the
                // plugin's restore guard, and the app comes up with no window,
                // no menu bar and no error (seen twice).
                if let Err(error) = window_builder.build() {
                    eprintln!("[mandate-desktop] failed to create window: {error}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_to_tray(window.clone());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Mandate desktop app");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            save_window_state(app_handle);
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

/// Where a page's request for a new window goes: every link in a report
/// (the report's runtime opens links in a new tab), `window.open`, and "Open
/// Link in New Window" all ask for one. An http(s) address opens in the
/// system browser; anything else (mailto:, file:, javascript:, the app's own
/// tauri:) is refused.
fn external_browser_url(url: &tauri::Url) -> Option<&str> {
    matches!(url.scheme(), "http" | "https").then(|| url.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_server_refused_its_data_directory_is_reported_in_use_with_the_running_ones_address() {
        let dir = std::env::temp_dir().join(format!("mandate-shell-in-use-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let address = |pid: u32| {
            format!(
                r#"{{"pid":{pid},"host":"127.0.0.1","port":4175,"url":"http://127.0.0.1:4175"}}"#
            )
        };
        // A live holder: its address.
        std::fs::write(dir.join("server.json"), address(std::process::id())).unwrap();
        let status = in_use_status(Some(DATA_DIR_IN_USE_EXIT), &dir).expect("in use");
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "in_use", "url": "http://127.0.0.1:4175" })
        );
        // A record a dead server left (a crash): no address to offer.
        std::fs::write(dir.join("server.json"), address(999_999_999)).unwrap();
        let stale = in_use_status(Some(DATA_DIR_IN_USE_EXIT), &dir).expect("in use");
        assert_eq!(
            serde_json::to_value(&stale).unwrap(),
            json!({ "state": "in_use", "url": null })
        );
        // No record at all.
        std::fs::remove_file(dir.join("server.json")).unwrap();
        let unnamed = in_use_status(Some(DATA_DIR_IN_USE_EXIT), &dir).expect("in use");
        assert_eq!(
            serde_json::to_value(&unnamed).unwrap(),
            json!({ "state": "in_use", "url": null })
        );
        for other in [None, Some(0), Some(1), Some(137)] {
            assert!(in_use_status(other, &dir).is_none());
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_web_addresses_leave_for_the_system_browser() {
        let url = |text: &str| tauri::Url::parse(text).unwrap();
        for web in [
            "https://github.com/acmecorp/fog",
            "http://127.0.0.1:4100/api/canvas/cnv_1/assets/notes.html",
        ] {
            assert_eq!(external_browser_url(&url(web)), Some(web));
        }
        for other in [
            "mailto:a@b.c",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri://localhost/index.html",
            "about:blank",
            "blob:http://127.0.0.1:4100/0b1f",
        ] {
            assert_eq!(external_browser_url(&url(other)), None, "{other}");
        }
    }

    #[test]
    fn configured_sidecar_config_reads_host_and_port_from_server() {
        let config = json!({ "server": { "host": "0.0.0.0", "port": 4777 } });
        let parsed = configured_sidecar_config_from_json(&config).unwrap();
        assert_eq!(parsed.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(parsed.port, Some(4777));
        // The flat keys of the layout before are not read.
        let flat = configured_sidecar_config_from_json(&json!({ "host": "0.0.0.0", "port": 4777 }))
            .unwrap();
        assert_eq!((flat.host, flat.port), (None, None));
    }

    #[test]
    fn a_port_written_as_a_string_is_refused_as_the_server_refuses_it() {
        let config = json!({ "server": { "port": "4777" } });
        assert!(configured_sidecar_config_from_json(&config).is_err());
    }

    #[test]
    fn sidecar_config_comes_from_config_json_alone() {
        let dir = std::env::temp_dir().join(format!("mandate-shell-config-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        let missing = sidecar_config_at(&file).unwrap();
        assert_eq!((missing.host, missing.port), (None, None));
        fs::write(
            &file,
            r#"{ "server": { "host": "0.0.0.0", "port": 4777 } }"#,
        )
        .unwrap();
        let parsed = sidecar_config_at(&file).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(parsed.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(parsed.port, Some(4777));
    }

    #[test]
    fn a_restart_whose_child_was_replaced_says_and_kills_nothing() {
        assert!(matches!(
            restart_verdict(true, true),
            RestartVerdict::Running
        ));
        assert!(matches!(
            restart_verdict(false, true),
            RestartVerdict::Stopped
        ));
        assert!(matches!(
            restart_verdict(true, false),
            RestartVerdict::Superseded
        ));
        assert!(matches!(
            restart_verdict(false, false),
            RestartVerdict::Superseded
        ));
    }

    #[test]
    fn a_users_restart_ends_early_only_on_a_stop_reported_during_it() {
        let in_use = BackendStatus::InUse { url: None };
        // The refusal the user pressed Restart on is not this restart's.
        assert!(!restart_given_up(4, 4, &in_use));
        // Its child crashed and the shell is retrying: that is waited for.
        assert!(!restart_given_up(
            4,
            5,
            &BackendStatus::Restarting {
                attempt: 1,
                code: Some(1)
            }
        ));
        assert!(restart_given_up(4, 5, &in_use));
        assert!(restart_given_up(
            4,
            6,
            &BackendStatus::Stopped {
                attempts: 3,
                code: Some(1)
            }
        ));
    }

    #[test]
    fn a_users_failed_restart_is_reported_stopped_one_attempt_on() {
        let after =
            |before: BackendStatus| serde_json::to_value(failed_restart_status(&before)).unwrap();
        assert_eq!(
            after(BackendStatus::InUse {
                url: Some("http://127.0.0.1:4175".into())
            }),
            json!({ "state": "stopped", "attempts": 1, "code": null })
        );
        assert_eq!(
            after(BackendStatus::Stopped {
                attempts: 3,
                code: Some(1)
            }),
            json!({ "state": "stopped", "attempts": 4, "code": null })
        );
        assert_eq!(
            after(BackendStatus::Running),
            json!({ "state": "stopped", "attempts": 1, "code": null })
        );
    }

    #[test]
    fn a_config_json_the_shell_cannot_read_leaves_the_port_to_it() {
        let dir = std::env::temp_dir().join(format!("mandate-shell-unread-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        fs::write(&file, r#"{ "port": "x", }"#).unwrap();
        let config = sidecar_config_or_automatic(&file);
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!((config.host, config.port), (None, None));
    }

    #[test]
    fn the_wait_for_the_server_ends_once_it_has_stopped() {
        let free = pick_unused_port(DEFAULT_SIDECAR_HOST).unwrap();
        let started = Instant::now();
        assert!(!wait_until_ready_or_stopped(
            DEFAULT_SIDECAR_HOST,
            free,
            Duration::from_secs(20),
            || true
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_bad_value_in_config_json_names_the_file() {
        let dir = std::env::temp_dir().join(format!("mandate-shell-bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        fs::write(&file, r#"{ "server": { "port": 70000 } }"#).unwrap();
        let error = sidecar_config_at(&file).unwrap_err();
        fs::remove_dir_all(&dir).unwrap();
        assert!(
            error.starts_with(&format!("{}: ", file.display())),
            "{error}"
        );
        assert!(error.contains("between 1 and 65535"), "{error}");
    }

    #[test]
    fn configured_sidecar_config_allows_zero_port_for_automatic() {
        let config = json!({ "server": { "port": 0 } });
        let parsed = configured_sidecar_config_from_json(&config).unwrap();
        assert_eq!(parsed.host, None);
        assert_eq!(parsed.port, None);
    }

    #[test]
    fn configured_sidecar_config_rejects_invalid_ports() {
        let config = json!({ "server": { "port": 70000 } });
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
