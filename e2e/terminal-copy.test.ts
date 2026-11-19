import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { waitUntil } from "../tests/helpers/wait.js";
import { terminalsAtPaneSize } from "./helpers/terminal-display.js";

// A terminal selection's Copy button sits by what is selected, as a phone's
// own copy menu does: above its first line, or below its last when there is
// no room above; out of sight while the selection is being made, and moved
// with it when output moves the screen.
const browser = browserForFile();

const LINES = Array.from({ length: 12 }, (_, i) => `line-${String(i + 1).padStart(2, "0")} some output to select`);
const OUTPUT = ["user@host demo % ls", ...LINES, "user@host demo % "].join("\r\n");

async function open(page: Page, baseUrl: string) {
  const sockets: Array<{ send: (data: string) => void }> = [];
  await page.routeWebSocket("**/api/terminal?*", (socket) => { sockets.push(socket); socket.send(OUTPUT); });
  await terminalsAtPaneSize(page);
  await page.goto(`${baseUrl}${WORKER_PATH}/pane/%250`);
  await page.locator(".xterm-rows > div", { hasText: "line-12" }).waitFor();
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  return { sockets, cell: { x: (col: number) => box.x + col * (box.width / 80), y: (row: number) => box.y + (row + 0.5) * (box.height / 24), height: box.height / 24 } };
}
const copyButton = (page: Page) => page.getByRole("button", { name: "Copy selection" });
const rowBox = async (page: Page, text: string) => (await page.locator(".xterm-rows > div", { hasText: text }).boundingBox())!;
const copiedMark = (page: Page) => page.locator('[data-slot="terminal-copied"]');
const toasts = (page: Page) => page.locator("[data-sonner-toast]");

test("on a desktop the Copy button shows once the drag ends, just above the selection's first line", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    const { cell } = await open(page, fixture.baseUrl);
    // Rows 5–7 (line-05 to line-07), from column 3.
    await page.mouse.move(cell.x(3), cell.y(5));
    await page.mouse.down();
    await page.mouse.move(cell.x(20), cell.y(7), { steps: 6 });
    expect(await copyButton(page).isVisible()).toBe(false);
    await page.mouse.up();
    await copyButton(page).waitFor();
    const button = (await copyButton(page).boundingBox())!;
    const first = await rowBox(page, "line-05");
    expect(button.y + button.height).toBeLessThanOrEqual(first.y);
    expect(first.y - (button.y + button.height)).toBeLessThan(cell.height);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

test("on a desktop a selection on the first line has its Copy button under it", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const { cell } = await open(page, fixture.baseUrl);
    await page.mouse.move(cell.x(1), cell.y(0));
    await page.mouse.down();
    await page.mouse.move(cell.x(19), cell.y(0), { steps: 4 });
    await page.mouse.up();
    await copyButton(page).waitFor();
    const button = (await copyButton(page).boundingBox())!;
    const first = await rowBox(page, "user@host demo % ls");
    expect(button.y).toBeGreaterThanOrEqual(first.y + first.height);
    expect(button.y - (first.y + first.height)).toBeLessThan(cell.height);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

test("output that moves the screen up takes the Copy button with the selection", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const { sockets, cell } = await open(page, fixture.baseUrl);
    await page.mouse.move(cell.x(1), cell.y(10));
    await page.mouse.down();
    await page.mouse.move(cell.x(20), cell.y(11), { steps: 4 });
    await page.mouse.up();
    await copyButton(page).waitFor();
    const before = (await copyButton(page).boundingBox())!;
    // Fourteen more lines from the prompt: the screen moves up four rows, the selection with it.
    sockets[0]!.send(`${Array.from({ length: 14 }, (_, i) => `more-${i + 1}`).join("\r\n")}\r\n`);
    await page.locator(".xterm-rows > div", { hasText: "more-14" }).waitFor();
    const first = await rowBox(page, "line-10");
    const after = await waitUntil(async () => {
      const box = await copyButton(page).boundingBox();
      return box && box.y < before.y - cell.height ? box : null;
    }, { label: "the Copy button moved up with the selection" });
    expect(after.y + after.height).toBeLessThanOrEqual(first.y);
    expect(first.y - (after.y + after.height)).toBeLessThan(cell.height);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

test("on a phone the Copy button sits above a long-pressed selection, clear of its handles", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const { cell } = await open(page, fixture.baseUrl);
    const cdp = await context.newCDPSession(page);
    const from = { x: Math.round(cell.x(2)), y: Math.round(cell.y(6)) };
    const to = { x: Math.round(cell.x(15)), y: Math.round(cell.y(7)) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    // Held: the long press selects a cell; the Copy button waits for the finger to lift.
    await page.getByRole("button", { name: "Drag selection start" }).waitFor();
    for (let i = 1; i <= 5; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(from.x + (to.x - from.x) * i / 5), y: Math.round(from.y + (to.y - from.y) * i / 5) }] });
    }
    expect(await copyButton(page).isVisible()).toBe(false);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await copyButton(page).waitFor();
    const button = (await copyButton(page).boundingBox())!;
    const first = await rowBox(page, "line-06");
    expect(button.y + button.height).toBeLessThanOrEqual(first.y);
    for (const name of ["Drag selection start", "Drag selection end"]) {
      const handle = (await page.getByRole("button", { name }).boundingBox())!;
      const apart = handle.y >= button.y + button.height || handle.y + handle.height <= button.y
        || handle.x >= button.x + button.width || handle.x + handle.width <= button.x;
      expect(apart).toBe(true);
    }
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// Smaller text changes the font, which moves the selection with the grid:
// the Copy button is placed again once the grid has its new size.
test("on a phone, the pane's size in smaller text chosen with text selected takes the Copy button with the selection", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  // From the pane's own size (open's), wider than the phone: smaller text narrows it.
  try {
    const { cell } = await open(page, fixture.baseUrl);
    const cdp = await context.newCDPSession(page);
    const at = { x: Math.round(cell.x(2)), y: Math.round(cell.y(8)) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await page.getByRole("button", { name: "Drag selection start" }).waitFor();
    // Drawn a few cells on, as a finger does: one let go where it pressed is
    // taken for a tap by the emulated touch, and a tap clears the selection.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(cell.x(10)), y: at.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await copyButton(page).waitFor();
    const before = (await page.locator(".xterm-screen").boundingBox())!;
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await page.getByRole("menuitem", { name: /^Display/ }).click();
    await page.getByRole("menuitemradio", { name: /^Pane's size, smaller/ }).click();
    await waitUntil(async () => ((await page.locator(".xterm-screen").boundingBox())!.width < before.width - 50 ? true : null), { label: "the grid fitted to the width" });
    await waitUntil(async () => {
      const button = await copyButton(page).boundingBox();
      const row = await rowBox(page, "line-08");
      return button && button.y + button.height <= row.y && row.y - (button.y + button.height) < row.height ? true : null;
    }, { label: "the Copy button just above the selection's line" });
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// The room the terminal shows in changes with no window resize when the
// sidebar comes back: the Copy button is placed again inside it.
test("on a narrow desktop, the sidebar expanded with text selected keeps the Copy button inside the terminal", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 800, height: 700 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send(OUTPUT); });
    await terminalsAtPaneSize(page);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`);
    await page.locator(".xterm-rows > div", { hasText: "line-12" }).waitFor();
    const room = page.locator(".xterm").locator("xpath=../..");
    const roomX = async () => (await room.boundingBox())!.x;
    const expanded = await roomX();
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await waitUntil(async () => ((await roomX()) < expanded - 100 ? true : null), { label: "the sidebar collapsed" });
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    const x = (col: number) => box.x + col * (box.width / 80);
    const y = box.y + 3.5 * (box.height / 24);
    // Columns 62–78 of row 3: near the grid's right end.
    await page.mouse.move(x(62), y);
    await page.mouse.down();
    await page.mouse.move(x(78), y, { steps: 4 });
    await page.mouse.up();
    await copyButton(page).waitFor();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    // The sidebar slides back: the room is as narrow as it was once it is in place.
    await waitUntil(async () => ((await roomX()) === expanded ? true : null), { label: "the sidebar back" });
    await waitUntil(async () => {
      const button = await copyButton(page).boundingBox();
      const shown = (await room.boundingBox())!;
      return button && button.x >= shown.x && button.x + button.width <= shown.x + shown.width ? true : null;
    }, { label: "the Copy button inside the terminal" });
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// Alt and drag selects a block, the same columns on every line: the Copy
// button is centred over those columns, not over the lines' whole width.
test("on a desktop a block selection has its Copy button over its columns", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const { cell } = await open(page, fixture.baseUrl);
    // Columns 20–30 of rows 3–6.
    await page.keyboard.down("Alt");
    await page.mouse.move(cell.x(20), cell.y(3));
    await page.mouse.down();
    await page.mouse.move(cell.x(30), cell.y(6), { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await copyButton(page).waitFor();
    const button = (await copyButton(page).boundingBox())!;
    const middle = button.x + button.width / 2;
    expect(middle).toBeGreaterThan(cell.x(20));
    expect(middle).toBeLessThan(cell.x(30));
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// Show keys covers the terminal's foot, and the terminal is then lifted to
// show its cursor's row above them: a selection there shows again, and so
// does its Copy button, once the lift is in place.
test("on a phone, Show keys over a selection near the foot brings its Copy button back once the terminal is lifted", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const rows = Array.from({ length: 60 }, (_, i) => `row-${String(i + 1).padStart(2, "0")} some output to select`);
    await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send(`${rows.join("\r\n")}\r\nuser@host demo % `); });
    await terminalsAtPaneSize(page);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`);
    await page.locator(".xterm-rows > div", { hasText: "row-60" }).waitFor();
    // A pane as tall as the phone: its last rows sit at the screen's foot.
    const next = fixture.connectState().snapshot;
    Object.assign(next.sessions[0]!.windows[0]!.panes![0]!, { paneHeight: 44 });
    fixture.emit("snapshot", next);
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.children.length === 44);
    // The last row, the prompt's: the keys come over it.
    const target = page.locator(".xterm-rows > div", { hasText: "user@host demo %" });
    const line = (await target.boundingBox())!;
    const cdp = await context.newCDPSession(page);
    const at = { x: Math.round(line.x + 20), y: Math.round(line.y + line.height / 2) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await page.getByRole("button", { name: "Drag selection start" }).waitFor();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at.x + 60, y: at.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await copyButton(page).waitFor();
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await page.getByRole("menuitem", { name: "Show keys" }).click();
    const escape = page.getByRole("button", { name: "Escape" });
    await escape.waitFor();
    expect(line.y + line.height).toBeGreaterThan((await escape.boundingBox())!.y);
    await waitUntil(async () => {
      const button = await copyButton(page).boundingBox();
      const keys = (await escape.boundingBox())!;
      const row = (await target.boundingBox())!;
      return button && row.y + row.height <= keys.y && button.y + button.height <= row.y ? true : null;
    }, { label: "the Copy button back above the lifted selection" });
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// Copied, the Copy button says so where it stood, a moment, as the app's
// other copy buttons do; no notice comes over the page, and the mark lets a
// click or a drag through to the terminal under it.
test("on a desktop Copy copies the selection and says Copied where it stood, with no notice; a drag from there selects again; light and dark", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    try {
      const { cell } = await open(page, fixture.baseUrl);
      await page.mouse.move(cell.x(3), cell.y(5));
      await page.mouse.down();
      await page.mouse.move(cell.x(20), cell.y(7), { steps: 6 });
      await page.mouse.up();
      await copyButton(page).waitFor();
      const button = (await copyButton(page).boundingBox())!;
      const buttonLook = await copyButton(page).evaluate((el) => getComputedStyle(el).backgroundColor);
      // A screen reader hears it from a status already on the page, empty until the copy.
      const status = page.locator('[data-slot="terminal-copy-status"][role="status"]');
      expect(await status.textContent()).toBe("");
      await copyButton(page).click();
      await copiedMark(page).waitFor();
      expect(await status.textContent()).toBe("Copied");
      expect((await copiedMark(page).textContent())?.trim()).toBe("Copied");
      // It looks like the button it stands for, over the terminal in either theme.
      expect(await copiedMark(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(buttonLook);
      const mark = (await copiedMark(page).boundingBox())!;
      expect([Math.abs(mark.x - button.x) < 1, Math.abs(mark.y - button.y) < 1]).toEqual([true, true]);
      expect(await copyButton(page).count()).toBe(0);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      // From the fourth column of line-05 to line-07.
      expect([copied.startsWith("e-05 some output"), copied.includes("line-07")]).toEqual([true, true]);
      expect(await toasts(page).count()).toBe(0);
      await look(page, `terminal-copied-${colorScheme}`, { clip: { x: Math.max(0, mark.x - 160), y: Math.max(0, mark.y - 60), width: 420, height: 160 }, animations: "disabled" });
      const centre = { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 };
      if (colorScheme === "light") {
        // The mark is not in the way: a drag that starts on it selects in the terminal.
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-slot="terminal-copied"]') == null, centre)).toBe(true);
        await page.mouse.move(centre.x, centre.y);
        await page.mouse.down();
        await page.mouse.move(cell.x(40), cell.y(9), { steps: 6 });
        await page.mouse.up();
        await copyButton(page).waitFor();
        expect(await copiedMark(page).count()).toBe(0);
      } else {
        // Left alone, it goes after a moment.
        await copiedMark(page).waitFor({ state: "detached", timeout: 4000 });
        expect(await copyButton(page).count()).toBe(0);
      }
      expect(await toasts(page).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
  fixture.stop();
}, 60_000);

test("on a phone a tapped Copy says Copied where it stood, with no notice, and goes after a moment", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    const { cell } = await open(page, fixture.baseUrl);
    const cdp = await context.newCDPSession(page);
    const from = { x: Math.round(cell.x(2)), y: Math.round(cell.y(6)) };
    const to = { x: Math.round(cell.x(15)), y: Math.round(cell.y(7)) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    await page.getByRole("button", { name: "Drag selection start" }).waitFor();
    for (let i = 1; i <= 5; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(from.x + (to.x - from.x) * i / 5), y: Math.round(from.y + (to.y - from.y) * i / 5) }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await copyButton(page).waitFor();
    const button = (await copyButton(page).boundingBox())!;
    await copyButton(page).tap();
    await copiedMark(page).waitFor();
    const mark = (await copiedMark(page).boundingBox())!;
    expect([Math.abs(mark.x - button.x) < 1, Math.abs(mark.y - button.y) < 1]).toEqual([true, true]);
    // From the third column of line-06.
    expect((await page.evaluate(() => navigator.clipboard.readText())).startsWith("ne-06 some output")).toBe(true);
    expect(await toasts(page).count()).toBe(0);
    await look(page, "terminal-copied-phone", { animations: "disabled" });
    await copiedMark(page).waitFor({ state: "detached", timeout: 4000 });
    expect(await toasts(page).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// On a narrow desktop the terminal shows less than its grid: a selection at
// its right edge has its Copy button pushed in, and the wider Copied mark too.
test("on a narrow desktop a selection at the terminal's right edge has its Copied mark inside the terminal", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 800, height: 700 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const { sockets, cell } = await open(page, fixture.baseUrl);
    // A full line of 80 columns under the prompt.
    sockets[0]!.send(`\r\n${"edge-".repeat(16)}`);
    await page.locator(".xterm-rows > div", { hasText: "edge-edge-edge" }).waitFor();
    const room = (await page.locator(".xterm").locator("xpath=../..").boundingBox())!;
    const width = (await page.locator(".xterm-screen").boundingBox())!.width / 80;
    const grid = (await page.locator(".xterm-screen").boundingBox())!.x;
    const last = Math.floor((room.x + room.width - grid) / width) - 1;
    expect(last).toBeLessThan(79);
    await page.mouse.move(cell.x(last - 2) + 1, cell.y(14));
    await page.mouse.down();
    await page.mouse.move(cell.x(last) + width - 1, cell.y(14), { steps: 4 });
    await page.mouse.up();
    await copyButton(page).waitFor();
    await copyButton(page).click();
    await copiedMark(page).waitFor();
    const mark = (await copiedMark(page).boundingBox())!;
    expect([mark.x >= room.x - 0.5, mark.x + mark.width <= room.x + room.width + 0.5]).toEqual([true, true]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);
