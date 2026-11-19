import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { BackendBanner } from "@/shell/BackendBanner";
import { resetBackendStatus, trackBackendStatusIfDesktop } from "@/shell/backend-status";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, settleUntil } from "../helpers/mount.js";

// The desktop shell can report a status before the page is there to hear it
// (a server that stopped at start, before the window opened): the page asks
// for the current one when it loads, and an event that comes after it wins.

type Status = { state: string; attempts?: number; code?: number | null };
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  runCleanups();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  resetBackendStatus();
});

/** The shell as the page's Tauri API reaches it: `backend_status` answers
 *  with `now` once `answer` is called; `emit` sends an event. */
function fakeShell(now: Status) {
  let handler: ((event: { payload: Status }) => void) | null = null;
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    transformCallback: (callback: (event: { payload: Status }) => void) => { handler = callback; return 1; },
    invoke: async (command: string) => {
      if (command === "plugin:event|listen") return 1;
      if (command === "backend_status") { await answered; return now; }
      return undefined;
    }
  };
  return { answer, emit: (payload: Status) => handler?.({ payload }), listening: () => handler !== null };
}

const bannerText = (el: HTMLElement) => el.querySelector('[data-slot="backend-banner"]')?.textContent ?? "";

test("a stop the shell reported before the page loaded shows at once", async () => {
  const shell = fakeShell({ state: "stopped", attempts: 3, code: 1 });
  const el = mount(<BackendBanner />).host;
  await act(async () => { trackBackendStatusIfDesktop(); shell.answer(); });
  await settleUntil(() => bannerText(el).includes("Backend stopped and could not be restarted."), "the stopped banner");
});

test("an event heard before the shell answers is not undone by the older answer", async () => {
  const shell = fakeShell({ state: "stopped", attempts: 3, code: 1 });
  const el = mount(<BackendBanner />).host;
  await act(async () => { trackBackendStatusIfDesktop(); });
  await settleUntil(shell.listening, "listening");
  await act(async () => { shell.emit({ state: "running" }); shell.answer(); });
  await settleUntil(() => true, "the answer", 5);
  expect(bannerText(el)).toBe("");
});
