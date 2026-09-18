import { afterEach, expect, test } from "bun:test";
import { applyTheme, resolveTheme } from "@/lib/theme";
import { useUIStore } from "@/store/ui";

afterEach(() => {
  useUIStore.setState({ theme: "system" });
  localStorage.removeItem("ap.ui");
  delete document.documentElement.dataset.theme;
});

/** A window whose dark-mode preference the test flips. */
function fakeWindow(dark: boolean) {
  let matches = dark;
  const listeners = new Set<() => void>();
  const mql = {
    get matches() { return matches; },
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); }
  } as unknown as MediaQueryList;
  return {
    win: { matchMedia: () => mql } as unknown as Window,
    flip(next: boolean) { matches = next; for (const fn of listeners) fn(); },
    get listeners() { return listeners.size; }
  };
}

test("resolveTheme: explicit values are themselves, system follows the preference", () => {
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
});

test("applyTheme stamps the resolved value and, for system, follows the OS until torn down", () => {
  const f = fakeWindow(true);
  const stop = applyTheme("system", document, f.win);
  expect(document.documentElement.dataset.theme).toBe("dark");
  f.flip(false);
  expect(document.documentElement.dataset.theme).toBe("light");
  stop();
  expect(f.listeners).toBe(0);
  f.flip(true);
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("applyTheme with an explicit theme never subscribes and never writes 'system' to the DOM", () => {
  const f = fakeWindow(true);
  const stop = applyTheme("light", document, f.win);
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(f.listeners).toBe(0);
  stop();
});

test("a window without matchMedia resolves system to light", () => {
  applyTheme("system", document, {} as Window);
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("the store defaults to system; a persisted explicit choice survives rehydration, anything else follows the system", async () => {
  expect(useUIStore.getState().theme).toBe("system");
  for (const [persisted, expected] of [["dark", "dark"], ["light", "light"], ["sepia", "system"], [undefined, "system"]] as const) {
    useUIStore.setState({ theme: "light" });
    localStorage.setItem("ap.ui", JSON.stringify({ state: { theme: persisted }, version: 0 }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().theme).toBe(expected);
  }
});
