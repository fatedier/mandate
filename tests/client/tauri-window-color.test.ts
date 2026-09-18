import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Tauri window paints this colour before the webview does. It must be
// the dark --panel so the first frame is the sidebar's colour, not white.
const root = join(import.meta.dir, "..", "..");
const rs = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
const css = readFileSync(join(root, "src", "client", "styles", "globals.css"), "utf8");

test("the Tauri window's first frame is --panel of the theme the system is in", () => {
  const body = rs.slice(rs.indexOf("fn first_frame_color()"), rs.indexOf("fn system_prefers_dark()"));
  const colors = Array.from(body.matchAll(/tauri::window::Color\(0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0xff\)/gi))
    .map((m) => `#${m[1]}${m[2]}${m[3]}`.toLowerCase());
  expect(colors).toHaveLength(2);
  const darkCss = css.slice(css.indexOf('\n[data-theme="dark"] {'));
  const lightCss = css.slice(css.indexOf("\n:root {"), css.indexOf('\n[data-theme="dark"] {'));
  const darkPanel = darkCss.match(/--panel:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase();
  const lightPanel = lightCss.match(/--panel:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase();
  // Dark branch first (the `if system_prefers_dark()` arm), then light.
  expect(colors).toEqual([darkPanel, lightPanel]);
  expect(rs).toContain(".background_color(first_frame_color())");
  expect(rs).toContain('.args(["read", "-g", "AppleInterfaceStyle"])');
});

test("the overlay title bar and drag permission are wired", () => {
  expect(rs).toContain("title_bar_style(tauri::TitleBarStyle::Overlay)");
  expect(rs).toContain("traffic_light_position(tauri::LogicalPosition::new(14.0, 20.0))");
  const cap = JSON.parse(readFileSync(join(root, "src-tauri", "capabilities", "default.json"), "utf8")) as { permissions: string[] };
  expect(cap.permissions).toContain("core:window:allow-start-dragging");
});

test("the View menu carries interface zoom with the browser accelerators, and the webview may set its zoom", () => {
  for (const item of [
    'MenuItem::with_id(handle, ZOOM_IN_ID, "Zoom In", true, Some("CmdOrCtrl+="))',
    'MenuItem::with_id(handle, ZOOM_OUT_ID, "Zoom Out", true, Some("CmdOrCtrl+-"))',
    'MenuItem::with_id(handle, ZOOM_RESET_ID, "Actual Size", true, Some("CmdOrCtrl+0"))'
  ]) expect(rs).toContain(item);
  // The items emit; the webview owns the factor (shell/desktop-zoom-wiring.ts listens for this name).
  expect(rs).toContain('const ZOOM_EVENT: &str = "mandate:zoom";');
  expect(rs).toContain("app.emit(ZOOM_EVENT, direction)");
  const cap = JSON.parse(readFileSync(join(root, "src-tauri", "capabilities", "default.json"), "utf8")) as { permissions: string[] };
  expect(cap.permissions).toContain("core:webview:allow-set-webview-zoom");
});

test("closing the window hides it to the tray, leaving macOS fullscreen first", () => {
  // Hiding a fullscreen window leaves its Space black until the user leaves
  // it by hand (seen on ⌘W, 2026-09-18).
  expect(rs).toContain("api.prevent_close();\n                hide_to_tray(window.clone());");
  const body = rs.slice(rs.indexOf("fn hide_to_tray("), rs.indexOf("fn show_main_window("));
  expect(body.indexOf("set_fullscreen(false)")).toBeGreaterThan(-1);
  expect(body.indexOf("set_fullscreen(false)")).toBeLessThan(body.indexOf("window.hide()"));
});

test("the sidecar is told the shell's pid so it exits with it", () => {
  expect(rs).toContain('"--parent-pid",\n                parent_pid.as_str(),');
  expect(rs).toContain("let parent_pid = std::process::id().to_string();");
});

test("the shell restarts a crashed sidecar and reports it; our own kills are expected exits", () => {
  const body = rs.slice(rs.indexOf("fn on_unexpected_exit("), rs.indexOf("fn kill("));
  expect(body).toContain("BackendStatus::Restarting { attempt, code }");
  expect(body).toContain("BackendStatus::Running");
  expect(body).toContain("BackendStatus::Stopped");
  const terminated = rs.slice(rs.indexOf("CommandEvent::Terminated(payload) => {"), rs.indexOf("sidecar.on_unexpected_exit(&app, payload.code);"));
  // Its own dead handle leaves the slot before the expected-exit check, and
  // only its own (pid match): a stale handle turned the next crash invisible.
  expect(terminated).toContain("slot.as_ref().map(|c| c.pid()) == Some(pid)");
  expect(terminated.indexOf("slot.take()")).toBeLessThan(terminated.indexOf("expected_exit.swap(false"));
  expect(rs).toContain('const BACKEND_EVENT: &str = "mandate:backend";');
  expect(rs).toContain("const CRASH_LIMIT: usize = 3;");
  expect(rs).toContain("const CRASH_WINDOW: Duration = Duration::from_secs(60);");
  // kill() marks the exit expected BEFORE killing, so the event loop cannot race it.
  const kill = rs.slice(rs.indexOf("fn kill("), rs.indexOf("fn restart("));
  expect(kill.indexOf("expected_exit.store(true")).toBeLessThan(kill.indexOf("child.kill()"));
  expect(rs).toContain("generate_handler![restart_backend, backend_log]");
  const cap = JSON.parse(readFileSync(join(root, "src-tauri", "capabilities", "default.json"), "utf8")) as { permissions: string[] };
  expect(cap.permissions).toContain("allow-backend-log");
});

test("the window is restored before it is shown, and its state is saved on hide and on quit", () => {
  expect(rs).toContain("tauri_plugin_window_state::Builder::new()");
  expect(rs).toContain("StateFlags::SIZE\n    .union(StateFlags::POSITION)\n    .union(StateFlags::MAXIMIZED)");
  // The plugin restores on window-ready by itself; an explicit restore_state
  // from the build thread deadlocks with that hook (no window, no menu bar).
  expect(rs).not.toContain("restore_state(");
  expect(rs).not.toContain(".visible(false)");
  const hide = rs.slice(rs.indexOf("fn hide_to_tray("), rs.indexOf("fn show_main_window("));
  expect(hide).toContain("save_window_state(window.app_handle())");
  const exit = rs.slice(rs.indexOf("RunEvent::ExitRequested"), rs.indexOf("RunEvent::Reopen"));
  expect(exit).toContain("save_window_state(app_handle)");
  expect(readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8")).toContain('tauri-plugin-window-state = "2"');
});

test("the Dock badge permission is granted", () => {
  const cap = JSON.parse(readFileSync(join(root, "src-tauri", "capabilities", "default.json"), "utf8")) as { permissions: string[] };
  expect(cap.permissions).toContain("core:window:allow-set-badge-count");
});
