import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { BackendBanner } from "@/shell/BackendBanner";
import { resetBackendStatus, setBackendStatus } from "@/shell/backend-status";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  // Unmount before the Tauri marker and the status the banner reads are reset under it.
  runCleanups();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  resetBackendStatus();
});

function render() {
  return mount(<BackendBanner />).host;
}
const banner = (el: HTMLElement) => el.querySelector('[data-slot="backend-banner"]');

test("running: nothing; restarting: the quiet line; stopped: the verdict with Restart and Show log", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const el = render();
  expect(banner(el) === null).toBe(true);
  act(() => setBackendStatus({ state: "restarting", attempt: 1, code: 1 }));
  expect(banner(el)?.getAttribute("data-state")).toBe("restarting");
  expect(banner(el)?.textContent).toContain("Restarting…");
  expect(el.querySelector("button") === null).toBe(true);
  act(() => setBackendStatus({ state: "stopped", attempts: 3, code: 1 }));
  expect(banner(el)?.getAttribute("data-state")).toBe("stopped");
  expect(banner(el)?.textContent).toContain("could not be restarted");
  expect(banner(el)?.textContent).toContain("exit code 1 · 3 attempts");
  const labels = Array.from(el.querySelectorAll("button")).map((b) => b.textContent);
  expect(labels).toEqual(["Restart", "Show log"]);
  act(() => setBackendStatus({ state: "running" }));
  expect(banner(el) === null).toBe(true);
});

test("a stop without an exit code and one attempt reads naturally", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const el = render();
  act(() => setBackendStatus({ state: "stopped", attempts: 1, code: null }));
  expect(banner(el)?.textContent).toContain("1 attempt");
  expect(banner(el)?.textContent).not.toContain("exit code");
});

test("browser: never shown, whatever the status", () => {
  const el = render();
  act(() => setBackendStatus({ state: "stopped", attempts: 3, code: 1 }));
  expect(banner(el) === null).toBe(true);
});
