import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BackendBanner } from "@/shell/BackendBanner";
import { resetBackendStatus, setBackendStatus, useBackendStatus } from "@/shell/backend-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  resetBackendStatus();
});

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<BackendBanner />);
  });
  return host!;
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

test("useBackendStatus follows setBackendStatus", () => {
  let seen: string[] = [];
  function Probe() { seen.push(useBackendStatus().state); return null; }
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<Probe />); });
  act(() => setBackendStatus({ state: "restarting", attempt: 2, code: null }));
  expect(seen.at(-1)).toBe("restarting");
  seen = [];
});
