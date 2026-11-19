import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { BackendBanner } from "@/shell/BackendBanner";
import { resetBackendStatus, setBackendStatus } from "@/shell/backend-status";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount, settleUntil } from "../helpers/mount.js";

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

const buttonNamed = (el: HTMLElement, name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === name);

test("in use: why and what to do, with Restart, Show log and Open the running one, which opens it in the browser", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const opened: unknown[][] = [];
  const open = window.open;
  window.open = ((...args: unknown[]) => { opened.push(args); return null; }) as typeof window.open;
  onCleanup(() => { window.open = open; });
  const el = render();
  act(() => setBackendStatus({ state: "in_use", url: "http://127.0.0.1:4175" }));
  expect(banner(el)?.getAttribute("data-state")).toBe("in_use");
  expect(banner(el)?.textContent).toContain("Another Mandate server is using this data directory.");
  expect(banner(el)?.textContent).toContain("Quit it, then Restart.");
  expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Restart", "Show log", "Open the running one"]);
  act(() => buttonNamed(el, "Open the running one")!.click());
  expect(opened).toEqual([["http://127.0.0.1:4175", "_blank", "noopener"]]);
});

test("in use with no address known: no Open the running one", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const el = render();
  act(() => setBackendStatus({ state: "in_use", url: null }));
  expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Restart", "Show log"]);
});

test("Restart while the other server still holds the directory comes back to why, not to Restarting…", async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      if (command === "restart_backend") throw new Error("backend did not become ready after restart");
      if (command === "backend_status") return { state: "in_use", url: "http://127.0.0.1:4175" };
      return undefined;
    }
  };
  const el = render();
  act(() => setBackendStatus({ state: "in_use", url: "http://127.0.0.1:4175" }));
  await act(async () => { buttonNamed(el, "Restart")!.click(); });
  await settleUntil(() => banner(el)?.getAttribute("data-state") === "in_use" && buttonNamed(el, "Restart")?.disabled === false, "the in-use banner again");
});
