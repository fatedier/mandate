import { expect, test } from "bun:test";
import { act } from "react";
import { TerminalControls, TerminalHeader } from "@/routes/terminal/TerminalHeader";
import { LiveTerminal, TerminalClosedNotice } from "@/routes/terminal/LiveTerminal";
import { TerminalControlsSlot, TerminalControlsSlotProvider } from "@/routes/terminal/terminal-controls-slot";
import { mount } from "../helpers/mount.js";
import { onCleanup } from "../helpers/cleanup.js";
import { useUIStore, type TerminalDisplay } from "@/store/ui";

const base = {
  isMobile: false, titleText: "Model list sync", path: "codex · work › main · ~/work", status: "connected" as const,
  windowZoomed: false, display: "auto" as TerminalDisplay, keysVisible: false,
  onDisplay: () => {}, onToggleKeysVisible: () => {}, onRefresh: () => {}
};

const controls = {
  isMobile: false, status: "connected" as const, windowZoomed: false, display: "auto" as TerminalDisplay, keysVisible: false,
  onDisplay: () => {}, onToggleKeysVisible: () => {}, onRefresh: () => {}
};
async function openMenu(host: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Terminal actions"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
}
/** An item's own words: a submenu's row without the way in use beside it. */
const words = (items: HTMLElement[]) => items.map((i) => {
  const copy = i.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-slot="menu-value"]').forEach((v) => v.remove());
  return copy.textContent?.trim();
});
/** The Display row's choices, opened as a touch or a click opens them. */
async function openDisplay(items: HTMLElement[]) {
  const row = items.find((i) => words([i])[0] === "Display")!;
  await act(async () => { row.click(); await new Promise((r) => setTimeout(r, 0)); });
  return [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-content"] [role="menuitemradio"]')];
}
const choice = (item: HTMLElement) => ({
  name: item.querySelector('[data-slot="display-name"]')?.textContent,
  hint: item.querySelector('[data-slot="display-hint"]')?.textContent,
  checked: item.getAttribute("aria-checked")
});
const menuLabel = () => document.querySelector('[role="menu"] [data-slot="dropdown-menu-label"]')?.textContent?.trim();

test("in a tab row a terminal's controls are its connection mark and ⋯: where it is, then Pin, then its own options", async () => {
  let toggled = 0;
  const el = mount(<TerminalControls {...controls} place="codex · work › main · ~/work" pin={{ pinned: false, onToggle: () => { toggled += 1; } }} />).host;
  expect(el.querySelector('[aria-label="connected"]') === null).toBe(false);
  const items = await openMenu(el);
  expect(menuLabel()).toBe("codex · work › main · ~/work");
  expect(words(items)).toEqual(["Pin", "Display", "Show keys", "Refresh"]);
  await act(async () => { items[0]!.click(); });
  expect(toggled).toBe(1);
});

test("on a phone the ⋯ holds the phone's options after Unpin", async () => {
  const el = mount(<TerminalControls {...controls} isMobile place="zsh · work › notes · ~" pin={{ pinned: true, onToggle: () => {} }} />).host;
  expect(words(await openMenu(el))).toEqual(["Unpin", "Display", "Show keys", "Refresh"]);
});

test("Display says the way in use and opens its choices beside the menu: on a desktop three, the one in use ticked", async () => {
  const picked: TerminalDisplay[] = [];
  const el = mount(<TerminalControls {...controls} display="pane" onDisplay={(d) => { picked.push(d); }} />).host;
  const items = await openMenu(el);
  expect(items.find((i) => words([i])[0] === "Display")!.querySelector('[data-slot="menu-value"]')?.textContent).toBe("Pane's size");
  const choices = await openDisplay(items);
  expect(choices.map(choice)).toEqual([
    { name: "Auto", hint: "Follows the screen used last.", checked: "false" },
    { name: "This screen", hint: "Always sized to this screen.", checked: "false" },
    { name: "Pane's size", hint: "Leaves tmux as it is. Scroll to see it all.", checked: "true" }
  ]);
  await act(async () => { choices[1]!.click(); });
  expect(picked).toEqual(["screen"]);
});

test("on a phone Display opens its choices in the same menu, a fourth among them, with a way back", async () => {
  const picked: TerminalDisplay[] = [];
  const el = mount(<TerminalControls {...controls} isMobile display="small" place="zsh · work › notes · ~" onDisplay={(d) => { picked.push(d); }} />).host;
  const items = await openMenu(el);
  await act(async () => { items.find((i) => words([i])[0] === "Display")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  // No menu beside it (a phone has no room there): the same menu, now its choices.
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]') === null).toBe(true);
  expect(menuLabel()).toBeUndefined();
  const menu = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')];
  const names = () => menu().map((i) => (i.getAttribute("role") === "menuitemradio" ? choice(i).name : words([i])[0]));
  expect(names()).toEqual(["Display", "Auto", "This screen", "Pane's size", "Pane's size, smaller"]);
  const choices = menu().filter((i) => i.getAttribute("role") === "menuitemradio");
  expect(choices.map(choice).at(-1)).toEqual({ name: "Pane's size, smaller", hint: "Leaves tmux as it is. Smaller text shows the whole width.", checked: "true" });
  // Back: the menu as it was.
  await act(async () => { menu()[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(words(menu())).toEqual(["Display", "Show keys", "Refresh"]);
  expect(menuLabel()).toBe("zsh · work › notes · ~");
  await act(async () => { menu().find((i) => words([i])[0] === "Display")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { menu().find((i) => choice(i).name === "Auto")!.click(); });
  expect(picked).toEqual(["auto"]);
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
});

test("a worker terminal's own header on a desktop has a Display button with the same choices, and no Fit browser", async () => {
  const picked: TerminalDisplay[] = [];
  const el = mount(<TerminalHeader {...base} onDisplay={(d) => { picked.push(d); }} />).host;
  expect(el.textContent).not.toContain("Fit browser");
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Display"))!;
  expect(button.querySelector('[data-slot="menu-value"]')?.textContent).toBe("Auto");
  await act(async () => {
    button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const choices = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
  expect(choices.map((c) => choice(c).name)).toEqual(["Auto", "This screen", "Pane's size"]);
  await act(async () => { choices[2]!.click(); });
  expect(picked).toEqual(["pane"]);
});

test("a closed terminal's controls add no status word", () => {
  const el = mount(<TerminalControls {...controls} status="closed" />).host;
  expect(el.textContent).not.toContain("closed");
});

test("a closed pane says so, in its fixed words", () => {
  const el = mount(<TerminalClosedNotice />).host;
  expect(el.textContent).toBe("This terminal has closed.");
});

test("a closed terminal's header adds no status word: the notice below says it", () => {
  const el = mount(<TerminalHeader {...base} status="closed" />).host;
  expect(el.textContent).not.toContain("closed");
});

/** WebSockets the terminal opens, kept to drive them by hand. */
function fakeSockets() {
  const made: Array<{ url: string; close: (code: number) => void; open: () => void; sent: string[]; deliver: (data: string) => void }> = [];
  const original = globalThis.WebSocket;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    binaryType = "blob";
    onopen: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    sent: string[] = [];
    constructor(readonly url: string) {
      made.push({
        url,
        close: (code) => { this.readyState = 3; this.onclose?.({ code } as CloseEvent); },
        open: () => { this.readyState = 1; this.onopen?.({} as Event); },
        sent: this.sent,
        deliver: (data) => { this.onmessage?.({ data } as MessageEvent); }
      });
    }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  onCleanup(() => { globalThis.WebSocket = original; });
  return made;
}

test("in a tab row's slot a live terminal draws no header of its own: its controls go to the slot", async () => {
  fakeSockets();
  const pane = { paneId: "%3", paneWidth: 80, paneHeight: 24, currentCommand: "zsh", currentPath: "/home/dev" };
  const view = mount(
    <TerminalControlsSlotProvider>
      <div data-testid="row"><TerminalControlsSlot /></div>
      <LiveTerminal pane={pane} expectPid={111} windowZoomed={false} header={{ titleText: "zsh · ~", path: "zsh · work › main · ~" }} />
    </TerminalControlsSlotProvider>
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(view.host.querySelector("header") === null).toBe(true);
  expect(view.host.querySelector('[data-testid="row"] [aria-label="Terminal actions"]') === null).toBe(false);
});

test("after a closed pane, the same terminal shown for another pane connects to it", async () => {
  const sockets = fakeSockets();
  const pane = (paneId: string) => ({ paneId, paneWidth: 80, paneHeight: 24, currentCommand: "zsh", currentPath: "/home/dev" });
  const header = { titleText: "zsh · ~", path: "zsh · work › main · ~" };
  const view = mount(<LiveTerminal pane={pane("%3")} expectPid={111} windowZoomed={false} header={header} />);
  expect(sockets.map((s) => new URL(s.url, "ws://x").searchParams.get("paneId"))).toEqual(["%3"]);
  act(() => { sockets[0]!.close(4404); });
  expect(view.host.textContent).toContain("This terminal has closed.");
  act(() => { view.rerender(<LiveTerminal pane={pane("%4")} expectPid={222} windowZoomed={false} header={header} />); });
  expect(view.host.textContent).not.toContain("This terminal has closed.");
  expect(sockets.map((s) => new URL(s.url, "ws://x").searchParams.get("paneId"))).toEqual(["%3", "%4"]);
  expect(new URL(sockets[1]!.url, "ws://x").searchParams.get("pid")).toBe("222");
  await turn();
});

// Fitted to the browser, a terminal kept behind another tab (kept-terminals.ts)
// keeps the fit it has: it asks for none while hidden, as it would take its
// window from the one shown when they share it, and asks for its own again
// when it shows.
const fitPane = { paneId: "%3", paneWidth: 80, paneHeight: 24, currentCommand: "zsh", currentPath: "/home/dev" };
const fitHeader = { titleText: "zsh · ~", path: "zsh · work › main · ~" };
const fitTerminal = (shown: boolean) => <LiveTerminal pane={fitPane} expectPid={111} windowZoomed={false} header={fitHeader} shown={shown} />;
const fitsAsked = (sent: string[]) => sent.map((m) => JSON.parse(m) as { type: string; enabled?: boolean; cols?: number; rows?: number; auto?: boolean; grace?: boolean; resume?: boolean }).filter((m) => m.type === "fit");
const asksFit = (url: string) => new URL(url, "ws://x").searchParams.get("fit") === "1";
const asksAuto = (url: string) => new URL(url, "ws://x").searchParams.get("auto") === "1";
const asksResume = (url: string) => new URL(url, "ws://x").searchParams.get("resume") === "1";
const turn = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function display(d: TerminalDisplay) {
  const before = useUIStore.getState().terminalDisplay;
  act(() => { useUIStore.getState().setTerminalDisplay(d); });
  // A terminal still mounted when it is put back hears of it.
  onCleanup(() => { act(() => { useUIStore.getState().setTerminalDisplay(before); }); });
}
/** "This screen": fitted while shown, never given back. */
const fitBrowser = (on: boolean) => display(on ? "screen" : "pane");
const fitOn = { type: "fit", enabled: true, cols: expect.any(Number), rows: expect.any(Number) };
/** The server's word on the terminal's socket: its window given back. */
const givenBack = (cols: number, rows: number) => `\u0000${JSON.stringify({ type: "given-back", cols, rows })}`;
const fitAuto = { ...fitOn, auto: true };

test("fitted, a terminal hidden behind another tab lets go of its window, leaving the one shown time to take it; shown again, it asks for its fit", async () => {
  fitBrowser(true);
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  expect(asksFit(sockets[0]!.url)).toBe(true);
  act(() => { sockets[0]!.open(); });
  await turn();
  const before = sockets[0]!.sent.length;
  view.rerender(fitTerminal(false));
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(before))).toEqual([{ type: "fit", enabled: false, grace: true }]);
  const hidden = sockets[0]!.sent.length;
  view.rerender(fitTerminal(true));
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(hidden))).toEqual([fitOn]);
});

test("fitted, a terminal that reconnects while hidden asks for no fit; shown before its socket opens, it asks once open", async () => {
  fitBrowser(true);
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  view.rerender(fitTerminal(false));
  act(() => { sockets[0]!.close(1006); });
  act(() => { window.dispatchEvent(new window.Event("mandate:sse-open")); });
  expect(sockets).toHaveLength(2);
  expect(asksFit(sockets[1]!.url)).toBe(false);
  view.rerender(fitTerminal(true));
  await turn();
  act(() => { sockets[1]!.open(); });
  await turn();
  expect(fitsAsked(sockets[1]!.sent)).toEqual([fitOn]);
});

test("fitted, a terminal first mounted hidden asks for no fit", () => {
  fitBrowser(true);
  const sockets = fakeSockets();
  mount(fitTerminal(false));
  expect(asksFit(sockets[0]!.url)).toBe(false);
});

test("switched to the pane's size, a fitted terminal lets go of its window at once", async () => {
  fitBrowser(true);
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const before = sockets[0]!.sent.length;
  act(() => { useUIStore.getState().setTerminalDisplay("pane"); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(before))).toEqual([{ type: "fit", enabled: false }]);
});

test("on Auto, the default, a shown terminal asks for its fit as Auto; on This screen not as Auto; on Pane's size for none", () => {
  display("auto");
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  expect([asksFit(sockets[0]!.url), asksAuto(sockets[0]!.url)]).toEqual([true, true]);
  display("screen");
  mount(fitTerminal(true));
  expect([asksFit(sockets[1]!.url), asksAuto(sockets[1]!.url)]).toEqual([true, false]);
  display("pane");
  mount(fitTerminal(true));
  expect([asksFit(sockets[2]!.url), asksAuto(sockets[2]!.url)]).toEqual([false, false]);
});

test("on Auto, given back to a terminal on its window used since, it shows the pane's size and lets go of any fit still its own; used again, it asks for its fit", async () => {
  display("auto");
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const before = sockets[0]!.sent.length;
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  // Its view turns to the pane's own size (a resize), and it lets go: a fit
  // asked for as the notice came would be its own again.
  expect(sockets[0]!.sent.slice(before).map((m) => (JSON.parse(m) as { type: string }).type)).toEqual(["resize", "fit"]);
  expect(fitsAsked(sockets[0]!.sent.slice(before))).toEqual([{ type: "fit", enabled: false }]);
  const xterm = view.host.querySelector<HTMLElement>(".xterm")!;
  const given = sockets[0]!.sent.length;
  act(() => { xterm.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(given))).toEqual([fitAuto]);
});

test("on Auto, given back, the page shown again (back from another app or window) counts as using it", async () => {
  display("auto");
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  const given = sockets[0]!.sent.length;
  act(() => { window.dispatchEvent(new window.Event("focus")); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(given))).toEqual([fitAuto]);
});

test("on This screen, a give-back notice changes nothing; the notice is never written to the terminal", async () => {
  display("screen");
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const before = sockets[0]!.sent.length;
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  await turn();
  expect(sockets[0]!.sent.slice(before)).toEqual([]);
  expect(view.host.querySelector(".xterm-rows")?.textContent ?? "").not.toContain("given-back");
});

test("fitted, a terminal asked for while shown but hidden before its socket opens gives its fit up on opening", async () => {
  fitBrowser(true);
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  expect(asksFit(sockets[0]!.url)).toBe(true);
  view.rerender(fitTerminal(false));
  await turn();
  act(() => { sockets[0]!.open(); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent)).toEqual([{ type: "fit", enabled: false }]);
});

test("hidden and still connecting when switched to the pane's size, a fitted terminal gives its fit up once its socket opens", async () => {
  fitBrowser(true);
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  view.rerender(fitTerminal(false));
  await turn();
  act(() => { useUIStore.getState().setTerminalDisplay("pane"); });
  await turn();
  act(() => { sockets[0]!.open(); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent)).toEqual([{ type: "fit", enabled: false }]);
});

// On a desktop the keyboard is the one at hand: the keys bar and its toggle
// leave the terminal focused, so a key pressed next (Ctrl, then a letter)
// goes to it, not to the button just clicked.
const frame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); await new Promise((r) => setTimeout(r, 0)); });
const inTerminal = (host: HTMLElement) => document.activeElement instanceof HTMLTextAreaElement
  && document.activeElement.classList.contains("xterm-helper-textarea") && host.contains(document.activeElement);

test("on a desktop, Show keys and each key of the bar leave the terminal focused", async () => {
  fakeSockets();
  const view = mount(<LiveTerminal pane={fitPane} expectPid={111} windowZoomed={false} header={fitHeader} />);
  await turn();
  const button = (name: string) => [...view.host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name)!;
  act(() => { button("Show keys").focus(); button("Show keys").click(); });
  await frame();
  expect(inTerminal(view.host)).toBe(true);
  // Focus elsewhere, then a key of the bar: the terminal has it again.
  act(() => { button("Hide keys").focus(); });
  expect(inTerminal(view.host)).toBe(false);
  act(() => { button("Control modifier").dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true })); });
  await frame();
  expect(inTerminal(view.host)).toBe(true);
  // Reached by Tab and pressed with Space: the terminal has it again too.
  act(() => { button("Alt modifier").focus(); });
  act(() => { button("Alt modifier").dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
  await frame();
  expect(inTerminal(view.host)).toBe(true);
});

test("in a tab row, Show keys chosen from the ⋯ menu leaves the terminal focused once the menu closes", async () => {
  fakeSockets();
  const view = mount(
    <TerminalControlsSlotProvider>
      <div data-testid="row"><TerminalControlsSlot /></div>
      <LiveTerminal pane={fitPane} expectPid={111} windowZoomed={false} header={fitHeader} />
    </TerminalControlsSlotProvider>
  );
  await turn();
  const items = await openMenu(view.host);
  const show = items.find((item) => item.textContent?.includes("Show keys"))!;
  await act(async () => { show.click(); });
  await frame();
  await frame();
  expect(inTerminal(view.host)).toBe(true);
});

test("fitted, switched between Auto and This screen, it tells the server which", async () => {
  display("auto");
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const before = sockets[0]!.sent.length;
  act(() => { useUIStore.getState().setTerminalDisplay("screen"); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(before))).toEqual([fitOn]);
  const screen = sockets[0]!.sent.length;
  act(() => { useUIStore.getState().setTerminalDisplay("auto"); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(screen))).toEqual([fitAuto]);
});

test("switched between Auto and This screen while its socket opens, it tells the server which once open", async () => {
  display("auto");
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  expect(asksAuto(sockets[0]!.url)).toBe(true);
  act(() => { useUIStore.getState().setTerminalDisplay("screen"); });
  await turn();
  act(() => { sockets[0]!.open(); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent)).toEqual([fitOn]);
});

test("on Auto, given back, a key of the keys bar is using it: it asks for its fit", async () => {
  display("auto");
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const button = (name: string) => [...view.host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name)!;
  act(() => { button("Show keys").click(); });
  await turn();
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  const given = sockets[0]!.sent.length;
  act(() => { button("Escape").dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true })); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(given))).toEqual([fitAuto]);
});

test("on Auto, given back, it takes the pane's size the notice brings before anything is painted, then lets go", async () => {
  display("auto");
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const before = sockets[0]!.sent.length;
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  const sent = sockets[0]!.sent.slice(before).map((m) => JSON.parse(m) as { type: string; cols?: number; rows?: number; enabled?: boolean });
  // Not the size the page last knew (80 × 24): the restored one, then the let-go
  // the server waits for to paint.
  expect(sent).toEqual([{ type: "resize", cols: 120, rows: 40 }, { type: "fit", enabled: false }]);
});

test("on Auto, given back, the terminal answering its pane by itself is not using it; a key pressed on it is", async () => {
  display("auto");
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  const given = sockets[0]!.sent.length;
  // A program asks where the cursor is: xterm answers on its own.
  act(() => { sockets[0]!.deliver("\u001b[6n"); });
  await turn();
  await turn();
  const after = sockets[0]!.sent.slice(given).map((m) => JSON.parse(m) as { type: string; data?: string });
  expect(after.some((m) => m.type === "input" && m.data?.endsWith("R"))).toBe(true);
  expect(fitsAsked(sockets[0]!.sent.slice(given))).toEqual([]);
  const textarea = view.host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
  act(() => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })); });
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(given))).toEqual([fitAuto]);
});

test("on Auto, each key pressed on it asks for its fit, ahead of what it types: a window another's viewer took comes back as it types", async () => {
  display("auto");
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const before = sockets[0]!.sent.length;
  const textarea = view.host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
  for (const key of ["a", "b"]) {
    act(() => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  }
  await turn();
  expect(fitsAsked(sockets[0]!.sent.slice(before))).toEqual([fitAuto, fitAuto]);
});

test("on Auto, given back, the notice's size goes for good once a newer snapshot's size comes", async () => {
  display("auto");
  const sockets = fakeSockets();
  const pane = (w: number, h: number) => ({ ...fitPane, paneWidth: w, paneHeight: h });
  const at = (w: number, h: number) => <LiveTerminal pane={pane(w, h)} expectPid={111} windowZoomed={false} header={fitHeader} shown />;
  const view = mount(at(80, 24));
  act(() => { sockets[0]!.open(); });
  await turn();
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  for (const [w, h] of [[120, 40], [100, 30], [80, 24]] as const) {
    act(() => { view.rerender(at(w, h)); });
    await turn();
  }
  const resizes = sockets[0]!.sent.map((m) => JSON.parse(m) as { type: string; cols?: number; rows?: number }).filter((m) => m.type === "resize");
  expect(resizes.at(-1)).toEqual({ type: "resize", cols: 80, rows: 24 });
});

test("on Auto, a socket come back asks for its fit as a resume, not as use: a window given back meanwhile stays given back", async () => {
  display("auto");
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  expect([asksFit(sockets[0]!.url), asksAuto(sockets[0]!.url)]).toEqual([true, true]);
  act(() => { sockets[0]!.open(); });
  await turn();
  act(() => { sockets[0]!.close(1006); });
  act(() => { window.dispatchEvent(new window.Event("mandate:sse-open")); });
  expect(sockets).toHaveLength(2);
  // Asked as a resume with the socket itself: the server decides before it paints.
  expect([asksFit(sockets[1]!.url), asksAuto(sockets[1]!.url), asksResume(sockets[1]!.url)]).toEqual([true, true, true]);
  act(() => { sockets[1]!.open(); });
  await turn();
  expect(fitsAsked(sockets[1]!.sent)).toEqual([]);
  // Answered given back: it shows the pane's size and lets go.
  const before = sockets[1]!.sent.length;
  act(() => { sockets[1]!.deliver(givenBack(120, 40)); });
  await turn();
  expect(fitsAsked(sockets[1]!.sent.slice(before))).toEqual([{ type: "fit", enabled: false }]);
});

test("on Auto, used while its socket is away (given back, then the page focused), it asks its fit as a use once back, not as a resume", async () => {
  display("auto");
  const sockets = fakeSockets();
  mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  act(() => { sockets[0]!.deliver(givenBack(120, 40)); });
  await turn();
  act(() => { sockets[0]!.close(1006); });
  // Back to the page while the socket is away: a use.
  act(() => { window.dispatchEvent(new window.Event("focus")); });
  await turn();
  act(() => { window.dispatchEvent(new window.Event("mandate:sse-open")); });
  const last = sockets.at(-1)!;
  // Asked as that use, not as a resume.
  expect([asksFit(last.url), asksAuto(last.url), asksResume(last.url)]).toEqual([true, true, false]);
});

test("on Auto, a given-back notice resizes the terminal to the pane's size before the next frame is written, not at the next render", async () => {
  display("auto");
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  const rows = () => view.host.querySelector(".xterm-rows")!.children.length;
  expect(rows()).toBe(24);
  let seen = 0;
  await act(async () => {
    sockets[0]!.deliver(givenBack(120, 40));
    // The frame queue has run; React has not rendered yet.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    seen = rows();
  });
  expect(seen).toBe(40);
});

test("on Auto, a socket come back as a resume and used while it opened asks again as that use; the resume's given-back answer changes nothing", async () => {
  display("auto");
  const sockets = fakeSockets();
  const view = mount(fitTerminal(true));
  act(() => { sockets[0]!.open(); });
  await turn();
  act(() => { sockets[0]!.close(1006); });
  act(() => { window.dispatchEvent(new window.Event("mandate:sse-open")); });
  const back = sockets.at(-1)!;
  expect(asksResume(back.url)).toBe(true);
  // Used before it opened.
  act(() => { window.dispatchEvent(new window.Event("focus")); });
  await turn();
  act(() => { back.open(); });
  await turn();
  expect(fitsAsked(back.sent)).toEqual([fitAuto]);
  const before = back.sent.length;
  act(() => { back.deliver(givenBack(120, 40)); });
  await turn();
  expect(fitsAsked(back.sent.slice(before))).toEqual([]);
  expect(view.host.querySelector(".xterm-rows")!.children.length).toBe(24);
});

for (const answered of ["given back", "taken"] as const) {
  test(`on Auto, a resume overridden by a use (its answer ${answered}) ignores only that answer: a give-back after its first paint is taken`, async () => {
    display("auto");
    const sockets = fakeSockets();
    const view = mount(fitTerminal(true));
    act(() => { sockets[0]!.open(); });
    await turn();
    act(() => { sockets[0]!.close(1006); });
    act(() => { window.dispatchEvent(new window.Event("mandate:sse-open")); });
    const back = sockets.at(-1)!;
    act(() => { window.dispatchEvent(new window.Event("focus")); });
    await turn();
    act(() => { back.open(); });
    await turn();
    if (answered === "given back") {
      act(() => { back.deliver(givenBack(120, 40)); });
      await turn();
    }
    // Its first paint, then a terminal on the window used later on.
    act(() => { back.deliver("$ "); });
    await turn();
    const before = back.sent.length;
    act(() => { back.deliver(givenBack(120, 40)); });
    await turn();
    expect(fitsAsked(back.sent.slice(before))).toEqual([{ type: "fit", enabled: false }]);
    expect(view.host.querySelector(".xterm-rows")!.children.length).toBe(40);
  });
}
