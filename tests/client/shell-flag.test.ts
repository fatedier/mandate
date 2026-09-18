import { afterEach, expect, test } from "bun:test";
import { applyShellFlag } from "@/lib/runtime";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  applyShellFlag();
});

test("no flag in a plain browser", () => {
  applyShellFlag();
  expect(document.documentElement.getAttribute("data-shell")).toBe(null);
});

test("data-shell=desktop iff the Tauri bridge is present", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  applyShellFlag();
  expect(document.documentElement.getAttribute("data-shell")).toBe("desktop");
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  applyShellFlag();
  expect(document.documentElement.getAttribute("data-shell")).toBe(null);
});
