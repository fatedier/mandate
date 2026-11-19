import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";
import { shellsSessionName } from "../src/server/modules/sessions/shells-session.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { look } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { expectFit, onPhone, PHONE, startTouchHarness, stopTouchHarness } from "./helpers/touch-targets.js";
import { waitUntil } from "../tests/helpers/wait.js";

// Terminals against real tmux: the panes you pin are tabs that stay, New
// terminal opens a shell that runs, the personal agent's panel opens one
// beside its chat, and a pane killed in tmux reads closed.

let server: RunningServer;
let browser: Awaited<ReturnType<typeof startTouchHarness>>["browser"];
const SESSION = `e2e-terms-${process.pid}`;
/** Mandate's own shells session for this server's data directory: New
 *  terminal makes it, the end closes it whichever tests ran. */
let shells = "";

const tmux = (...args: string[]) => {
  const r = spawnSync("tmux", args, { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) throw new Error(`tmux ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
/** The session's panes as tmux has them: `[paneId, pid]`. */
const panesOf = (session: string) => tmux("list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id} #{pane_pid}")
  .split("\n").filter(Boolean).map((line) => { const [id, pid] = line.split(" "); return [id!, Number(pid)] as const; });

beforeAll(async () => {
  ({ browser } = await startTouchHarness({ server: false }));
  server = await startServer({
    configured: true,
    // A named personal agent, so /agent opens on its chat and panel.
    seed(dataDir) {
      const configFile = path.join(dataDir, "config.json");
      const config = flatFromFile(JSON.parse(fs.readFileSync(configFile, "utf8"))) as Record<string, any>;
      config.agent = { ...config.agent, personalAgentName: "Juno" };
      fs.writeFileSync(configFile, JSON.stringify(fileFromFlat(config), null, 2));
    }
  });
  shells = shellsSessionName(server.dataDir);
  tmux("new-session", "-d", "-s", SESSION, "-c", "/tmp");
  tmux("new-window", "-d", "-t", `=${SESSION}:`, "-n", "notes", "-c", "/tmp");
});

afterAll(async () => {
  spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`], { timeout: 3000 });
  if (shells) spawnSync("tmux", ["kill-session", "-t", `=${shells}`], { timeout: 3000 });
  server?.cleanup();
  await stopTouchHarness();
});

async function desktop(path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(server.baseUrl + path);
  return { page, close: () => context.close() };
}
/** Frames for a person to look at, in light and dark, when frames are kept
 *  (MANDATE_E2E_CAPTURE_FRAMES=1); nothing otherwise. */
const CAPTURE = process.env.MANDATE_E2E_CAPTURE_FRAMES === "1";
async function lookBoth(page: Page, name: string): Promise<void> {
  if (!CAPTURE) return;
  const drawn = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await drawn();
    await look(page, `${name}-${scheme}`, { animations: "disabled" });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const pins = async () => ((await (await fetch(`${server.baseUrl}/api/terminals`)).json()) as { pins: Array<{ paneId: string }> }).pins.map((p) => p.paneId);

test("All lists the session; a pane pinned from it is a tab, and still one after a reload", async () => {
  const [paneId] = panesOf(SESSION)[0]!;
  const { page, close } = await desktop("/terminals");
  try {
    await page.getByText(SESSION, { exact: true }).waitFor();
    const row = page.locator(`[data-pane-row="${paneId}"]`);
    await row.hover();
    await row.getByRole("button", { name: "Pin" }).click();
    await page.locator(`[role="tab"][data-terminal-tab="${paneId}"]`).waitFor();
    await page.reload();
    await page.locator(`[role="tab"][data-terminal-tab="${paneId}"]`).waitFor();
    expect(await pins()).toContain(paneId);
    if (CAPTURE) {
      await page.getByText(SESSION, { exact: true }).waitFor();
      await lookBoth(page, "all-1440");
      await page.locator(`[role="tab"][data-terminal-tab="${paneId}"]`).click();
      await page.locator(".xterm-rows").waitFor();
      await lookBoth(page, "pinned-tab-1440");
      // One of two windows side by side on a 1440 screen.
      await page.setViewportSize({ width: 720, height: 900 });
      await lookBoth(page, "pinned-tab-720");
      await page.getByRole("tab", { name: "All" }).click();
      await page.getByText(SESSION, { exact: true }).waitFor();
      await lookBoth(page, "all-720");
      const phone = await browser.newContext(PHONE);
      try {
        const onPhonePage = await phone.newPage();
        await onPhonePage.goto(`${server.baseUrl}/terminals/pane/${encodeURIComponent(paneId)}?pid=${panesOf(SESSION)[0]![1]}`);
        await onPhonePage.locator(".xterm-rows").waitFor();
        await lookBoth(onPhonePage, "phone-pinned-tab");
      } finally {
        await phone.close();
      }
    }
  } finally {
    await close();
  }
}, 40_000);

test("New terminal opens a shell that runs, under Mandate's shells session in All", async () => {
  const { page, close } = await desktop("/terminals");
  try {
    await page.getByRole("button", { name: "New terminal" }).click();
    await page.waitForURL(/\/terminals\/pane\/%25\d+\?pid=\d+$/);
    const paneId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
    const made = ((await (await fetch(`${server.baseUrl}/api/panes/${encodeURIComponent(paneId)}`)).json()) as { sessionName: string }).sessionName;
    expect(made).toBe(shells);
    await page.locator(".xterm-rows").waitFor();
    await page.locator(".xterm").click();
    await page.keyboard.type("echo $((40+2))\n");
    await page.waitForFunction(() => /(^|\D)42(\D|$)/.test(document.querySelector(".xterm-rows")?.textContent?.replace(/echo \$\(\(40\+2\)\)/, "") ?? ""));
    await page.getByRole("tab", { name: "All" }).click();
    await page.getByText(shells, { exact: true }).waitFor();
  } finally {
    await close();
  }
}, 40_000);

test("Esc and Ctrl+[ typed into a terminal reach its pane", async () => {
  const { page, close } = await desktop("/terminals");
  try {
    await page.getByRole("button", { name: "New terminal" }).click();
    await page.waitForURL(/\/terminals\/pane\/%25\d+\?pid=\d+$/);
    await page.locator(".xterm-rows").waitFor();
    await page.locator(".xterm").click();
    await page.keyboard.type("cat -v\n");
    await page.keyboard.press("Escape");
    await page.keyboard.type("a");
    await page.keyboard.press("Control+BracketLeft");
    await page.keyboard.type("b\n");
    // cat -v shows ESC as ^[.
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("^[a^[b"));
    await page.keyboard.press("Control+c");
  } finally {
    await close();
  }
}, 40_000);

test("on This screen, a terminal shown again is the connection it had and fits its window again; let go, the window takes its size from tmux again", async () => {
  const [a, pidA] = panesOf(SESSION)[0]!;
  const [b] = tmux("list-panes", "-t", `=${SESSION}:notes`, "-F", "#{pane_id}").split("\n");
  const windowSize = (paneId: string) => tmux("display-message", "-p", "-t", paneId, "#{window_width}x#{window_height}");
  const unfitted = windowSize(a);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const sockets: string[] = [];
    page.on("websocket", (ws) => { if (ws.url().includes("paneId=")) sockets.push(new URL(ws.url()).searchParams.get("paneId")!); });
    await page.goto(`${server.baseUrl}/terminals/pane/${encodeURIComponent(a)}?pid=${pidA}`);
    await page.locator(".xterm-rows").waitFor();
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await page.getByRole("menuitem", { name: /^Display/ }).click();
    await page.getByRole("menuitemradio", { name: /^This screen/ }).click();
    const fitted = await waitUntil(() => (windowSize(a) !== unfitted ? windowSize(a) : null), { label: "the window fitted" });

    await page.getByRole("tab", { name: "All" }).click();
    await page.locator(`[data-open-pane="${b}"]`).click();
    await page.waitForURL(new RegExp(`/terminals/pane/${encodeURIComponent(b!)}\\?pid=\\d+$`));
    await page.locator(`[data-kept-terminal^="${b}:"]:not(.invisible) .xterm-rows`).waitFor();
    await page.locator(`[role="tab"][data-terminal-tab="${a}"]`).click();
    await page.locator(`[data-kept-terminal="${a}:${pidA}"]:not(.invisible) .xterm-rows`).waitFor();
    expect(sockets).toEqual([a, b]);
    await waitUntil(() => (windowSize(a) === fitted ? true : null), { label: "the window fitted again" });

    // Let go (Pane's size): the window is put back as it was, with no
    // window-size of its own — resizing it set one (manual), which would
    // keep it from following the terminal attached to it.
    const ownSize = () => tmux("show-options", "-wqv", "-t", a, "window-size");
    expect(ownSize()).toBe("manual");
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await page.getByRole("menuitem", { name: /^Display/ }).click();
    await page.getByRole("menuitemradio", { name: /^Pane's size/ }).click();
    await waitUntil(() => (windowSize(a) === unfitted && ownSize() === "" ? true : null), { label: "the window put back, its size tmux's" });
  } finally {
    await context.close();
  }
}, 40_000);

test("a terminal left for another page and come back to is the connection it had; meanwhile it takes no clicks", async () => {
  const [a, pidA] = panesOf(SESSION)[0]!;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const sockets: string[] = [];
    page.on("websocket", (ws) => { if (ws.url().includes("paneId=")) sockets.push(new URL(ws.url()).searchParams.get("paneId")!); });
    await page.goto(`${server.baseUrl}/terminals/pane/${encodeURIComponent(a)}?pid=${pidA}`);
    await page.locator(".xterm-rows").waitFor();
    await page.locator('[data-slot="tasks-nav"]').click();
    await page.waitForURL(/\/tasks$/);
    // Hidden once the Tasks page has come (it loads first, and the old page
    // stays up meanwhile); over it, nothing of the hidden one is hit.
    await page.locator(`[data-kept-terminal="${a}:${pidA}"].invisible`).waitFor({ state: "attached" });
    const hit = await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("[data-kept-terminal]") !== null);
    expect(hit).toBe(false);
    // Taller than the place pages take, it still adds nothing to the Tasks
    // page's scrolling.
    const scrolls = () => page.evaluate(() => document.querySelector("main")!.scrollHeight);
    const before = await scrolls();
    await page.evaluate((key) => {
      const tall = document.createElement("div");
      tall.setAttribute("data-test-tall", "");
      // Locked to a height, as a terminal is while a phone's keyboard is open.
      tall.style.height = "3000px";
      tall.style.flex = "none";
      document.querySelector(`[data-kept-terminal="${key}"]`)!.appendChild(tall);
    }, `${a}:${pidA}`);
    expect(await scrolls()).toBe(before);
    await page.evaluate(() => document.querySelector("[data-test-tall]")!.remove());
    await page.goBack();
    await page.locator(`[data-kept-terminal="${a}:${pidA}"]:not(.invisible) .xterm-rows`).waitFor();
    expect(sockets).toEqual([a]);
  } finally {
    await context.close();
  }
}, 40_000);

test("the personal agent's + opens a new shell as a tab beside its chat", async () => {
  const { page, close } = await desktop("/agent");
  try {
    await page.getByRole("button", { name: "Open a thread beside Juno" }).click({ timeout: 15_000 });
    if (CAPTURE) {
      await page.getByRole("menuitem", { name: "New terminal" }).waitFor();
      await lookBoth(page, "agent-plus-menu");
    }
    await page.getByRole("menuitem", { name: "New terminal" }).click();
    // Beside the chat, in the panel: the page stays the agent's.
    const panel = page.locator('[data-pane-mode="page"]');
    await panel.locator('[role="tab"][data-terminal-tab]').waitFor();
    await panel.locator(".xterm-rows").waitFor();
    expect(new URL(page.url()).pathname).toBe("/agent");
    expect(await page.locator('[data-slot="composer"] textarea').isVisible()).toBe(true);
    await lookBoth(page, "agent-panel-terminal");
  } finally {
    await close();
  }
}, 40_000);

test("a pinned pane killed in tmux reads closed, and its pin goes", async () => {
  tmux("split-window", "-d", "-t", `=${SESSION}:notes`, "-c", "/tmp");
  const [paneId, pid] = panesOf(SESSION).at(-1)!;
  await fetch(`${server.baseUrl}/api/terminals/pins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId, pid }) });
  // The pin needs the poll to have seen the pane: try until it takes.
  for (let i = 0; i < 20 && !(await pins()).includes(paneId); i++) {
    await new Promise((r) => setTimeout(r, 500));
    await fetch(`${server.baseUrl}/api/terminals/pins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId, pid }) });
  }
  expect(await pins()).toContain(paneId);
  const { page, close } = await desktop(`/terminals/pane/${encodeURIComponent(paneId)}?pid=${pid}`);
  try {
    await page.locator(".xterm-rows").waitFor();
    // Shown pinned first (a pin has no ×), so its tab taking a × below is
    // the pin going.
    const tab = `[role="tab"][data-terminal-tab="${paneId}"]`;
    await page.locator(`${tab}:not(:has([aria-label^="Close"]))`).waitFor();
    tmux("kill-pane", "-t", paneId);
    await page.getByText("This terminal has closed.").waitFor({ timeout: 15_000 });
    await lookBoth(page, "closed");
    // The page's own reads drop the pin: its tab turns an open one there
    // first (a read from here would drop it on the page's behalf).
    await page.locator(`${tab}:has([aria-label^="Close"])`).waitFor({ timeout: 15_000 });
    expect(await pins()).not.toContain(paneId);
  } finally {
    await close();
  }
}, 40_000);

test("on a phone the tab row and the pins are touch-sized", async () => {
  expectFit("terminals, All", await onPhone(`${server.baseUrl}/terminals`, `text=${SESSION}`, (page) => lookBoth(page, "phone-all")));
}, 40_000);

test("a long title is cut short in its tab and whole on hover; on a phone a pinned terminal's header and tabs are touch-sized", async () => {
  // In ASCII: tmux in the container has no UTF-8 locale and writes other
  // characters as "_" (a full-width title's tooltip is a client test).
  const LONG = "Sync the bread list into the order sheet, then check every supplier's price table";
  // A program that is not a shell is named by its title.
  tmux("new-window", "-d", "-t", `=${SESSION}:`, "-n", "long", "-c", "/tmp", "sleep 600");
  const [paneId, pid] = panesOf(SESSION).at(-1)!;
  tmux("select-pane", "-t", paneId, "-T", LONG);
  const pin = () => fetch(`${server.baseUrl}/api/terminals/pins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId, pid }) });
  await pin();
  for (let i = 0; i < 20 && !(await pins()).includes(paneId); i++) {
    await new Promise((r) => setTimeout(r, 500));
    await pin();
  }
  expect(await pins()).toContain(paneId);
  const listed = async () => ((await (await fetch(`${server.baseUrl}/api/terminals`)).json()) as { sessions: Array<{ windows: Array<{ panes: Array<{ paneId: string; title: string | null; currentCommand: string }> }> }> })
    .sessions.flatMap((s) => s.windows.flatMap((w) => w.panes)).find((p) => p.paneId === paneId);
  expect(await listed()).toMatchObject({ title: LONG, currentCommand: "sleep" });
  const { page, close } = await desktop("/terminals");
  try {
    const label = page.locator(`[role="tab"][data-terminal-tab="${paneId}"] span[title]`);
    await label.filter({ hasText: LONG }).waitFor();
    expect(await label.getAttribute("title")).toBe(`${LONG}\n${SESSION} › long`);
    const shown = await label.evaluate((el) => ({ width: el.getBoundingClientRect().width, cut: el.scrollWidth > el.clientWidth }));
    expect(shown.cut).toBe(true);
    expect(shown.width).toBeLessThanOrEqual(224.5);
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await close();
  }
  expectFit("terminals, a pinned terminal", await onPhone(`${server.baseUrl}/terminals/pane/${encodeURIComponent(paneId)}?pid=${pid}`, ".xterm-rows"));
}, 40_000);
