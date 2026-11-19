import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { BrowserContextOptions, Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { PHONE, startTouchHarness, stopTouchHarness } from "./helpers/touch-targets.js";
import { waitUntil } from "../tests/helpers/wait.js";

// The Terminals page's tabs, dragged into another order against real tmux:
// pins among the pins (the server's order, every device's), open tabs among
// the open tabs (this browser's). The tab carried is a solid copy over the
// row; a phone holds, then drags, and a swipe still scrolls the row.

let server: RunningServer;
let browser: Awaited<ReturnType<typeof startTouchHarness>>["browser"];
const SESSION = `e2e-tabdrag-${process.pid}`;

const tmux = (...args: string[]) => {
  const r = spawnSync("tmux", args, { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) throw new Error(`tmux ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
/** The session's panes as tmux has them, one per window: `[paneId, pid]`. */
let panes: Array<readonly [string, number]> = [];

beforeAll(async () => {
  ({ browser } = await startTouchHarness({ server: false }));
  server = await startServer({ configured: true });
  tmux("new-session", "-d", "-s", SESSION, "-c", "/tmp");
  for (const name of ["two", "three", "four", "five", "six"]) tmux("new-window", "-d", "-t", `=${SESSION}:`, "-n", name, "-c", "/tmp");
  // A program that is not a shell is named by its title: one wide tab, one
  // narrow (panes 6 and 7).
  tmux("new-window", "-d", "-t", `=${SESSION}:`, "-n", "wide", "-c", "/tmp", "sleep 600");
  tmux("new-window", "-d", "-t", `=${SESSION}:`, "-n", "narrow", "-c", "/tmp", "sleep 600");
  panes = tmux("list-panes", "-s", "-t", `=${SESSION}`, "-F", "#{pane_id} #{pane_pid}")
    .split("\n").filter(Boolean).map((line) => { const [id, pid] = line.split(" "); return [id!, Number(pid)] as const; });
  tmux("select-pane", "-t", panes[6]![0], "-T", "Copy the bread menu into the order sheet and check the prices");
  tmux("select-pane", "-t", panes[7]![0], "-T", "logs");
});

afterAll(async () => {
  spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`], { timeout: 3000 });
  server?.cleanup();
  await stopTouchHarness();
});

const api = (path: string, init?: RequestInit) => fetch(`${server.baseUrl}${path}`, init);
const pinIds = async () => ((await (await api("/api/terminals")).json()) as { pins: Array<{ paneId: string }> }).pins.map((p) => p.paneId);
/** Exactly these panes pinned, in this order (a pin waits for the server's
 *  next look at tmux). */
async function pinOnly(...which: number[]) {
  for (const id of await pinIds()) await api(`/api/terminals/pins/${encodeURIComponent(id)}`, { method: "DELETE" });
  for (const i of which) {
    const [paneId, pid] = panes[i]!;
    await waitUntil(async () => (await api("/api/terminals/pins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId, pid }) })).ok || null, { timeout: 10_000, label: `pin ${paneId}` });
  }
  expect(await pinIds()).toEqual(which.map((i) => panes[i]![0]));
}
const href = (i: number) => `/terminals/pane/${encodeURIComponent(panes[i]![0])}?pid=${panes[i]![1]}`;

/** A browser on the Terminals page with these panes opened as tabs, in this
 *  order, then the first pin shown. */
async function openPage(device: BrowserContextOptions, opened: number[], show: string) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  for (const i of opened) {
    await page.goto(server.baseUrl + href(i));
    // Its tab shows at once, but it is kept (store/terminal-tabs.ts, this
    // browser's list) only once the list of panes was read: left before
    // that, it would not be one of the open tabs.
    await page.waitForFunction((id) => {
      const kept = JSON.parse(localStorage.getItem("mandate.terminal-tabs.v1") ?? "{}") as { state?: { open?: Array<{ paneId: string }> } };
      return (kept.state?.open ?? []).some((t) => t.paneId === id);
    }, panes[i]![0]);
  }
  await page.goto(server.baseUrl + show);
  await page.locator('[role="tablist"] [role="tab"]').first().waitFor();
  return { page, close: () => context.close() };
}
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
/** The row's terminal tabs, by pane id, in order. */
const order = (page: Page) => page.locator('[role="tablist"] [role="tab"][data-terminal-tab]').evaluateAll((tabs) => tabs.map((t) => t.getAttribute("data-terminal-tab")));
/** The row's tabs in this order, once they are there (the pins come with
 *  the list read, after the page draws). */
const expectOrder = async (page: Page, panesInOrder: number[]) => {
  const want = JSON.stringify(panesInOrder.map((i) => panes[i]![0]));
  // Waited for; the expect below then says what the row has instead.
  await waitUntil(async () => JSON.stringify(await order(page)) === want || null, { label: `tabs ${want}` }).catch(() => {});
  expect(await order(page)).toEqual(panesInOrder.map((i) => panes[i]![0]));
};
const tabBox = async (page: Page, i: number) => (await page.locator(`[role="tablist"] [role="tab"][data-terminal-tab="${panes[i]![0]}"]`).boundingBox())!;

/** Presses `from`'s middle (or a point given), carries it to `to`'s `at`
 *  (a share of its width), holds there and lets go. */
async function drag(page: Page, from: number, to: number, at = 0.8, press?: { x: number; y: number }) {
  const a = await tabBox(page, from);
  const b = await tabBox(page, to);
  const start = press ?? { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 10, start.y, { steps: 3 });
  await page.mouse.move(b.x + b.width * at, start.y, { steps: 12 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test("a pin dragged onto the next pin takes its place, on the server too, and another browser shows the new order", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage(DESKTOP, [], href(0));
  const other = await openPage(DESKTOP, [], href(0));
  try {
    await expectOrder(page, [0, 1]);
    await drag(page, 0, 1);
    await expectOrder(page, [1, 0]);
    expect(await pinIds()).toEqual([panes[1]![0], panes[0]![0]]);
    await waitUntil(async () => JSON.stringify(await order(other.page)) === JSON.stringify([panes[1]![0], panes[0]![0]]) || null, { label: "the other browser's tabs in the new order" });
  } finally {
    await close();
    await other.close();
  }
}, 60_000);

test("an open tab dragged onto another open tab moves there, and a reload keeps it; a pin carried over the open tabs stays last among the pins", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage(DESKTOP, [2, 3, 4], href(2));
  try {
    await expectOrder(page, [0, 1, 2, 3, 4]);
    await drag(page, 2, 4);
    await expectOrder(page, [0, 1, 3, 4, 2]);
    await page.reload();
    await page.locator(`[role="tablist"] [role="tab"][data-terminal-tab="${panes[2]![0]}"]`).waitFor();
    await expectOrder(page, [0, 1, 3, 4, 2]);
    // Over the open tabs, as far as the last one: the pins' end is as far as it goes.
    await drag(page, 0, 2, 0.9);
    await expectOrder(page, [1, 0, 3, 4, 2]);
    expect(await pinIds()).toEqual([panes[1]![0], panes[0]![0]]);
  } finally {
    await close();
  }
}, 60_000);

test("the tab carried is solid, light and dark, and stays over its own group's tabs", async () => {
  await pinOnly(0, 1);
  for (const colorScheme of ["light", "dark"] as const) {
    const { page, close } = await openPage({ ...DESKTOP, colorScheme }, [2, 3], href(2));
    try {
      const a = await tabBox(page, 2);
      const b = await tabBox(page, 3);
      const pinStart = (await tabBox(page, 0)).x;
      const openStart = Math.min(a.x, b.x);
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 });
      await page.mouse.move(b.x + b.width / 2, a.y + a.height / 2, { steps: 8 });
      const carried = page.locator("[data-carried]");
      const alpha = await carried.evaluate((el) => {
        const probe = document.createElement("canvas").getContext("2d")!;
        probe.fillStyle = getComputedStyle(el).backgroundColor;
        probe.fillRect(0, 0, 1, 1);
        return probe.getImageData(0, 0, 1, 1).data[3];
      });
      expect(alpha).toBe(255);
      // Toward the pins, as far as the row's start: it stops where its group starts.
      await page.mouse.move(pinStart + 4, a.y + a.height / 2, { steps: 10 });
      expect(Math.round((await carried.boundingBox())!.x)).toBeGreaterThanOrEqual(Math.round(openStart) - 1);
      await page.mouse.up();
    } finally {
      await close();
    }
  }
}, 60_000);

test("a press on an open tab's × carried 20px drags the tab and leaves it open; a click on × closes it", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(DESKTOP, [2, 3], href(0));
  try {
    const x = page.locator(`[role="tablist"] [role="tab"][data-terminal-tab="${panes[2]![0]}"] [aria-label^="Close"]`);
    const box = (await x.boundingBox())!;
    await drag(page, 2, 3, 0.9, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await expectOrder(page, [0, 3, 2]);
    await x.click();
    await expectOrder(page, [0, 3]);
  } finally {
    await close();
  }
}, 60_000);

test("Move right in ⋯ moves the shown pin one place, on the server", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage(DESKTOP, [], href(0));
  try {
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await page.getByRole("menuitem", { name: "Move right" }).click();
    await waitUntil(async () => JSON.stringify(await pinIds()) === JSON.stringify([panes[1]![0], panes[0]![0]]) || null, { label: "the pins in the new order" });
    await expectOrder(page, [1, 0]);
  } finally {
    await close();
  }
}, 60_000);

test("a pointer resting on a tab near the row's end does not scroll the row from under it", async () => {
  await pinOnly(0);
  const { page, close } = await openPage({ viewport: { width: 720, height: 900 } }, [1, 2, 3, 4, 5], href(0));
  try {
    const row = page.locator('[role="tablist"]');
    expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const rowBox = (await row.boundingBox())!;
    const a = await tabBox(page, 1);
    // Held over a tab at 85% of the row: short of its last tenth, where the
    // row scrolls; inside the fifth that dnd-kit's own default would take.
    const restX = rowBox.x + rowBox.width * 0.85;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 });
    await page.mouse.move(restX, a.y + a.height / 2, { steps: 10 });
    const before = await row.evaluate((el) => el.scrollLeft);
    await page.waitForTimeout(500);
    expect(await row.evaluate((el) => el.scrollLeft)).toBe(before);
    await page.mouse.up();
  } finally {
    await close();
  }
}, 60_000);

test("with less motion asked for, the copy carried is gone in the first frame after the drop", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage({ ...DESKTOP, reducedMotion: "reduce" }, [], href(0));
  try {
    const a = await tabBox(page, 0);
    const b = await tabBox(page, 1);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 });
    await page.mouse.move(b.x + b.width * 0.8, a.y + a.height / 2, { steps: 8 });
    await page.locator("[data-carried]").waitFor();
    await page.mouse.up();
    const left = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(document.querySelectorAll("[data-carried]").length))));
    expect(left).toBe(0);
  } finally {
    await close();
  }
}, 60_000);

test("on a phone a hold then a drag moves a tab; a quick swipe scrolls the row and moves none; nothing is selected", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage(PHONE, [2, 3], href(0));
  try {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const row = page.locator('[role="tablist"]');
    const before = await order(page);
    // A swipe: no hold first.
    const a = await tabBox(page, 0);
    await row.evaluate((el) => { el.scrollLeft = 0; });
    const start = await row.evaluate((el) => el.scrollLeft);
    await touch("touchStart", a.x + a.width / 2, a.y + a.height / 2);
    for (let i = 1; i <= 8; i++) { await touch("touchMove", a.x + a.width / 2 - i * 12, a.y + a.height / 2); await page.waitForTimeout(16); }
    await touch("touchEnd");
    await page.waitForTimeout(400);
    expect(await row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(start);
    expect(await order(page)).toEqual(before);
    // A hold, then the drag onto the next pin.
    await row.evaluate((el) => { el.scrollLeft = 0; });
    await page.waitForTimeout(200);
    const p0 = await tabBox(page, 0);
    const p1 = await tabBox(page, 1);
    await touch("touchStart", p0.x + p0.width / 2, p0.y + p0.height / 2);
    await page.waitForTimeout(450);
    const rowRight = (await row.boundingBox())!.x + (await row.boundingBox())!.width;
    const to = Math.min(p1.x + p1.width * 0.7, rowRight - 8);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", p0.x + p0.width / 2 + (to - p0.x - p0.width / 2) * i / 10, p0.y + p0.height / 2); await page.waitForTimeout(25); }
    await page.waitForTimeout(300);
    await touch("touchEnd");
    await page.waitForTimeout(400);
    await expectOrder(page, [1, 0, 2, 3]);
    expect(await page.evaluate(() => String(getSelection()))).toBe("");
    expect(await pinIds()).toEqual([panes[1]![0], panes[0]![0]]);
  } finally {
    await close();
  }
}, 60_000);


test("a wide tab held by its × and let go over the middle of a narrow one moves there", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(DESKTOP, [6, 7], href(0));
  try {
    const wide = await tabBox(page, 6);
    const narrow = await tabBox(page, 7);
    expect(wide.width).toBeGreaterThan(narrow.width * 2);
    const x = (await page.locator(`[role="tablist"] [role="tab"][data-terminal-tab="${panes[6]![0]}"] [aria-label^="Close"]`).boundingBox())!;
    await drag(page, 6, 7, 0.5, { x: x.x + x.width / 2, y: x.y + x.height / 2 });
    await expectOrder(page, [0, 7, 6]);
  } finally {
    await close();
  }
}, 60_000);

test("a pin unpinned on another device while it is carried moves nowhere when let go over an open tab", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(DESKTOP, [2, 3], href(0));
  try {
    // Pane 2, open here first, pinned: a pin, and still on this browser's open list, unshown.
    await waitUntil(async () => (await api("/api/terminals/pins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId: panes[2]![0], pid: panes[2]![1] }) })).ok || null, { timeout: 10_000, label: "pin pane 2" });
    const pinned = page.locator(`[role="tablist"] [role="tab"][data-terminal-tab="${panes[2]![0]}"]`);
    await waitUntil(async () => (await pinned.getAttribute("data-sort-order")) === "pins" || null, { label: "pane 2 a pin here" });
    const a = (await pinned.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 });
    await page.locator("[data-carried]").waitFor();
    await api(`/api/terminals/pins/${encodeURIComponent(panes[2]![0])}`, { method: "DELETE" });
    await waitUntil(async () => (await pinned.getAttribute("data-sort-order")) === "open" || null, { label: "pane 2 an open tab again" });
    const b = await tabBox(page, 3);
    await page.mouse.move(b.x + b.width * 0.8, a.y + a.height / 2, { steps: 10 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expectOrder(page, [0, 2, 3]);
    expect(await pinIds()).toEqual([panes[0]![0]]);
  } finally {
    await close();
  }
}, 60_000);

async function onTouch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  return (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
}

/** The row as it stays: the pins read in (they come after the page draws)
 *  and the header's controls in, before the row is scrolled or measured. */
async function settledRow(page: Page, panesInOrder: number[]) {
  await expectOrder(page, panesInOrder);
  await page.getByRole("button", { name: "Terminal actions" }).waitFor();
}

test("on a phone a pin held still past the row's edge scrolls the row only as far as the pins go", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage(PHONE, [2, 3, 4], href(0));
  try {
    const touch = await onTouch(page);
    const row = page.locator('[role="tablist"]');
    await row.evaluate((el) => { el.scrollLeft = 0; });
    await page.waitForTimeout(200);
    const box = (await row.boundingBox())!;
    const a = await tabBox(page, 0);
    await touch("touchStart", a.x + a.width / 2, a.y + a.height / 2);
    await page.waitForTimeout(450);
    for (let i = 1; i <= 8; i++) { await touch("touchMove", a.x + a.width / 2 + (box.x + box.width + 6 - a.x - a.width / 2) * i / 8, a.y + a.height / 2); await page.waitForTimeout(20); }
    // Held still there.
    await page.waitForTimeout(1500);
    const reach = await row.evaluate((el, id) => {
      const last = [...el.children].find((c) => c.getAttribute("data-terminal-tab") === id) as HTMLElement;
      return { scroll: el.scrollLeft, most: last.offsetLeft + last.offsetWidth + Number.parseFloat(getComputedStyle(el).paddingLeft) - el.clientWidth };
    }, panes[1]![0]);
    await touch("touchEnd");
    expect(reach.scroll).toBeLessThanOrEqual(Math.max(0, reach.most) + 1);
  } finally {
    await close();
  }
}, 60_000);

test("on a phone a tab picked up where only a sliver of its group shows is cut to the row, not drawn over the header's controls", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage(PHONE, [2, 3], href(0));
  try {
    const touch = await onTouch(page);
    const row = page.locator('[role="tablist"]');
    const box = (await row.boundingBox())!;
    // The first open tab's start 30px inside the row's right edge.
    await row.evaluate((el, id) => {
      const first = [...el.children].find((c) => c.getAttribute("data-terminal-tab") === id) as HTMLElement;
      el.scrollLeft = first.offsetLeft - (el.clientWidth - 30);
    }, panes[2]![0]);
    await page.waitForTimeout(200);
    const y = (await tabBox(page, 2)).y + 12;
    await touch("touchStart", box.x + box.width - 25, y);
    await page.waitForTimeout(450);
    await page.locator("[data-carried]").waitFor();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const shown = await page.locator("[data-carried]").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cut = /inset\(0(?:px)? ([\d.]+)px 0(?:px)? ([\d.]+)px\)/.exec(el.style.clipPath);
      return { right: r.right - (cut ? Number(cut[1]) : 0) };
    });
    await touch("touchEnd");
    expect(shown.right).toBeLessThanOrEqual(box.x + box.width + 1);
  } finally {
    await close();
  }
}, 60_000);


// A short drag whose one move both starts it and reaches the next tab, let
// go there without moving again, drops there.
test("a tab carried into the next one by the very move that starts the drag, and let go at once, drops there", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(DESKTOP, [2, 3], href(0));
  try {
    await expectOrder(page, [0, 2, 3]);
    const a = await tabBox(page, 2);
    await page.mouse.move(a.x + a.width - 3, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width + 12, a.y + a.height / 2, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expectOrder(page, [0, 3, 2]);
  } finally {
    await close();
  }
}, 60_000);

test("held where the very move that started the drag took it, the next tab has already slid aside", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(DESKTOP, [2, 3], href(0));
  try {
    await expectOrder(page, [0, 2, 3]);
    const a = await tabBox(page, 2);
    const next = page.locator(`[role="tablist"] [role="tab"][data-terminal-tab="${panes[3]![0]}"]`);
    await page.mouse.move(a.x + a.width - 3, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width + 12, a.y + a.height / 2, { steps: 1 });
    await page.waitForTimeout(400);
    const slid = await next.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
    await page.mouse.up();
    expect(slid).toBeLessThan(-20);
  } finally {
    await close();
  }
}, 60_000);

test("on a phone, a tab let go on a tab at the row's edge settles into its place without crossing the header's controls", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(PHONE, [2, 3, 4], href(0));
  try {
    const touch = await onTouch(page);
    const row = page.locator('[role="tablist"]');
    const box = (await row.boundingBox())!;
    // Pane 3's start 40px inside the row's right edge, pane 2 in sight before it.
    await row.evaluate((el, id) => {
      const target = [...el.children].find((c) => c.getAttribute("data-terminal-tab") === id) as HTMLElement;
      el.scrollLeft = target.offsetLeft - (el.clientWidth - 40);
    }, panes[3]![0]);
    await page.waitForTimeout(200);
    const a = await tabBox(page, 2);
    const from = Math.max(a.x + 10, box.x + 10);
    await touch("touchStart", from, a.y + a.height / 2);
    await page.waitForTimeout(450);
    const to = box.x + box.width - 20;
    for (let i = 1; i <= 6; i++) { await touch("touchMove", from + (to - from) * i / 6, a.y + a.height / 2); await page.waitForTimeout(20); }
    // Every frame of the drop, the copy's drawn right edge.
    await page.evaluate(() => {
      const w = window as unknown as { __rightmost: number; __watch: boolean };
      w.__rightmost = 0;
      w.__watch = true;
      const look = () => {
        const copy = document.querySelector<HTMLElement>("[data-carried]");
        if (copy) {
          const cut = /inset\(0(?:px)? ([\d.]+)px/.exec(copy.style.clipPath);
          w.__rightmost = Math.max(w.__rightmost, copy.getBoundingClientRect().right - (cut ? Number(cut[1]) : 0));
        }
        if (w.__watch) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await touch("touchEnd");
    await page.waitForTimeout(400);
    const rightmost = await page.evaluate(() => { const w = window as unknown as { __rightmost: number; __watch: boolean }; w.__watch = false; return w.__rightmost; });
    expect(rightmost).toBeLessThanOrEqual(box.x + box.width + 1);
    await expectOrder(page, [0, 3, 2, 4]);
  } finally {
    await close();
  }
}, 60_000);

test("let go with both it and its place in sight, the copy glides there: still drawn in the first frame after the drop", async () => {
  await pinOnly(0, 1);
  const { page, close } = await openPage(DESKTOP, [], href(0));
  try {
    const a = await tabBox(page, 0);
    const b = await tabBox(page, 1);
    // Let go over the next tab's start: short of where it lands (held right
    // at its place, there is nothing to glide, and dnd-kit draws none).
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 });
    await page.mouse.move(b.x + b.width * 0.3, a.y + a.height / 2, { steps: 8 });
    await page.locator("[data-carried]").waitFor();
    await page.mouse.up();
    const left = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(document.querySelectorAll("[data-carried]").length))));
    expect(left).toBe(1);
  } finally {
    await close();
  }
}, 60_000);

// Escape puts the tab back, and its way back is held to the same rule as a
// drop: no glide across the header's controls.
test("on a phone, Escape on a tab carried until its own place scrolled out of sight puts it back without crossing the header's controls", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(PHONE, [6, 2, 3, 4], href(0));
  try {
    const touch = await onTouch(page);
    const row = page.locator('[role="tablist"]');
    await settledRow(page, [0, 6, 2, 3, 4]);
    const box = (await row.boundingBox())!;
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.waitForTimeout(200);
    const a = await tabBox(page, 4);
    const from = Math.min(a.x + a.width / 2, box.x + box.width - 20);
    await touch("touchStart", from, a.y + a.height / 2);
    await page.waitForTimeout(450);
    // Carried past the row's left edge and held: the row scrolls back to the
    // wide tab that opens the group, and pane 4's own place goes out past its right edge.
    for (let i = 1; i <= 8; i++) { await touch("touchMove", from + (box.x - 6 - from) * i / 8, a.y + a.height / 2); await page.waitForTimeout(20); }
    await page.waitForTimeout(1200);
    // Its own place by layout (the node itself is moved aside while carried).
    const pastEdge = await row.evaluate((el, id) => {
      const own = [...el.children].find((c) => c.getAttribute("data-terminal-tab") === id) as HTMLElement;
      return own.offsetLeft - el.scrollLeft - el.clientWidth;
    }, panes[4]![0]);
    expect(pastEdge).toBeGreaterThan(0);
    await page.evaluate(() => {
      const w = window as unknown as { __rightmost: number; __watch: boolean };
      w.__rightmost = 0;
      w.__watch = true;
      const look = () => {
        const copy = document.querySelector<HTMLElement>("[data-carried]");
        if (copy) {
          const cut = /inset\(0(?:px)? ([\d.]+)px/.exec(copy.style.clipPath);
          w.__rightmost = Math.max(w.__rightmost, copy.getBoundingClientRect().right - (cut ? Number(cut[1]) : 0));
        }
        if (w.__watch) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await touch("touchEnd");
    const rightmost = await page.evaluate(() => { const w = window as unknown as { __rightmost: number; __watch: boolean }; w.__watch = false; return w.__rightmost; });
    expect(rightmost).toBeLessThanOrEqual(box.x + box.width + 1);
    await expectOrder(page, [0, 6, 2, 3, 4]);
  } finally {
    await close();
  }
}, 60_000);

// A tab dropped on its neighbour, the row scrolled away from the shown pin,
// leaves the row where it is; it is not scrolled back to the pin.
test("on a phone, a tab dropped on its neighbour, the row scrolled away from the shown pin, leaves the row where it was", async () => {
  await pinOnly(0);
  const { page, close } = await openPage(PHONE, [2, 3, 4], href(0));
  try {
    const touch = await onTouch(page);
    const row = page.locator('[role="tablist"]');
    await settledRow(page, [0, 2, 3, 4]);
    const box = (await row.boundingBox())!;
    // Pane 3's last 60px in sight at the row's start, pane 4 after it.
    await row.evaluate((el, id) => {
      const three = [...el.children].find((c) => c.getAttribute("data-terminal-tab") === id) as HTMLElement;
      el.scrollLeft = three.offsetLeft + three.offsetWidth - 60;
    }, panes[3]![0]);
    await page.waitForTimeout(200);
    const before = await row.evaluate((el) => el.scrollLeft);
    const a = await tabBox(page, 4);
    const from = (Math.max(a.x, box.x) + Math.min(a.x + a.width, box.x + box.width)) / 2;
    await touch("touchStart", from, a.y + a.height / 2);
    await page.waitForTimeout(450);
    // Onto pane 3's part in sight, clear of the edge where the row scrolls.
    const to = box.x + 30;
    for (let i = 1; i <= 6; i++) { await touch("touchMove", from + (to - from) * i / 6, a.y + a.height / 2); await page.waitForTimeout(20); }
    await page.waitForTimeout(300);
    expect(await row.evaluate((el) => el.scrollLeft)).toBe(before);
    await touch("touchEnd");
    await expectOrder(page, [0, 2, 4, 3]);
    await page.waitForTimeout(300);
    expect(await row.evaluate((el) => el.scrollLeft)).toBe(before);
  } finally {
    await close();
  }
}, 60_000);
