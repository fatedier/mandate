import { afterAll, beforeAll, expect, test } from "bun:test";
import { browserForFile } from "./helpers/browser";
import { attachPageDiagnostics } from "./helpers/page-diagnostics";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { kinds, SCREENS } from "./helpers/terminal-scroll";

/**
 * Travel a gesture has not yet turned into input: where it goes when the
 * gesture stops short, moves sideways, or the program switches screens under
 * it. Split from terminal-scroll-routes, which covers where a whole scroll
 * goes, so the two run side by side.
 */

let fixture: ReturnType<typeof startWorkspaceFixture>;
const browser = browserForFile();
beforeAll(async () => {
  fixture = startWorkspaceFixture();
});
afterAll(async () => {
  fixture?.stop();
});

test("a drag's unreported travel does not carry into a later wheel on a device with both", async () => {
  fixture.setTerminalPane(true, "codex");
  // A touchscreen laptop: a finger and a wheel on the same page.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  attachPageDiagnostics(page);
  const inputs: string[] = [];
  await page.routeWebSocket("**/api/terminal?*", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "input") inputs.push(message.data);
    });
    socket.send(SCREENS.alternate);
  });
  try {
    await page.goto(fixture.baseUrl + WORKER_PATH + "/pane/%250");
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("FULL SCREEN VIEW"));
    await page.waitForTimeout(300);
    const { fontSize, cellHeight } = await page.evaluate(() => {
      const rows = document.querySelector(".xterm-rows")!;
      const screen = document.querySelector(".xterm-screen")!.getBoundingClientRect();
      return { fontSize: parseFloat(getComputedStyle(rows).fontSize), cellHeight: screen.height / rows.children.length };
    });
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.3;
    // Two lines of drag: short of a report, which needs three.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 2 * fontSize * 1.16 + 0.05 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(200);
    // Then one line of wheel: still short, on its own.
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -cellHeight);
    await page.waitForTimeout(300);
    expect(inputs).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);

async function openPlain(options: { phone: boolean; command: string; first: string }) {
  fixture.setTerminalPane(true, options.command);
  const context = await browser.newContext(options.phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  attachPageDiagnostics(page);
  const inputs: string[] = [];
  let socket: import("playwright").WebSocketRoute | null = null;
  await page.routeWebSocket("**/api/terminal?*", (route) => {
    socket = route;
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "input") inputs.push(message.data);
    });
    route.send(options.first);
  });
  await page.goto(fixture.baseUrl + WORKER_PATH + "/pane/%250");
  await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").length > 10);
  await page.waitForTimeout(300);
  const metrics = await page.evaluate(() => {
    const rows = document.querySelector(".xterm-rows")!;
    const screen = document.querySelector(".xterm-screen")!.getBoundingClientRect();
    return { fontSize: parseFloat(getComputedStyle(rows).fontSize), cellHeight: screen.height / rows.children.length };
  });
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  return { context, page, inputs, send: (bytes: string) => socket!.send(Buffer.from(bytes)), ...metrics, x: box.x + box.width / 2, y: box.y + box.height * 0.3 };
}

test("desktop: a mostly sideways wheel over codex is left alone, its vertical jitter included", async () => {
  const t = await openPlain({ phone: false, command: "codex", first: SCREENS.alternate });
  try {
    await t.page.mouse.move(t.x, t.y);
    // Sideways, with a little more than three lines of vertical drift.
    await t.page.mouse.wheel(-400, -t.cellHeight * 3.2);
    await t.page.waitForTimeout(300);
    expect(t.inputs).toEqual([]);
  } finally {
    await t.context.close();
  }
}, 60_000);

test("phone: a fraction of a line dragged on one screen does not reach the program of the next", async () => {
  const t = await openPlain({ phone: true, command: "zsh", first: SCREENS.normal });
  try {
    const line = t.fontSize * 1.16;
    const cdp = await t.context.newCDPSession(t.page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x, y: t.y }] });
    // Past the long-press tolerance, then 0.8 line short of a whole one.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y + 3 * line }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y + 3.8 * line }] });
    // The program goes full screen under the finger.
    t.send("\x1b[?1049h\x1b[2J\x1b[HFULL SCREEN VIEW");
    await t.page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("FULL SCREEN VIEW"));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y + 4.2 * line }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await t.page.waitForTimeout(300);
    expect(t.inputs).toEqual([]);
  } finally {
    await t.context.close();
  }
}, 60_000);

test("phone: travel pending for codex is dropped when a sub-line move goes elsewhere in between", async () => {
  const t = await openPlain({ phone: true, command: "codex", first: SCREENS.alternate });
  try {
    const line = t.fontSize * 1.16;
    const cdp = await t.context.newCDPSession(t.page);
    const moveTo = (lines: number) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y + lines * line + 0.05 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x, y: t.y }] });
    // Two lines for Codex: short of a report.
    await moveTo(1);
    await moveTo(2);
    // Codex leaves the alternate screen; half a line goes to the history.
    t.send("\x1b[?1049lSHELL");
    await t.page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("SHELL"));
    await moveTo(2.5);
    // Back to Codex full screen; one more line is one line, not a report.
    t.send("\x1b[?1049h\x1b[2J\x1b[HFULL AGAIN");
    await t.page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("FULL AGAIN"));
    await moveTo(3.5);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await t.page.waitForTimeout(300);
    expect(t.inputs).toEqual([]);
  } finally {
    await t.context.close();
  }
}, 60_000);

test("phone: a sideways move while the program switches screens also drops travel pending for codex", async () => {
  const t = await openPlain({ phone: true, command: "codex", first: SCREENS.alternate });
  try {
    const line = t.fontSize * 1.16;
    const cdp = await t.context.newCDPSession(t.page);
    const moveTo = (dx: number, lines: number) =>
      cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x + dx, y: t.y + lines * line + 0.05 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x, y: t.y }] });
    await moveTo(0, 1);
    await moveTo(0, 2);
    t.send("\x1b[?1049lSHELL");
    await t.page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("SHELL"));
    // Sideways, on the shell's screen.
    await moveTo(60, 2.2);
    t.send("\x1b[?1049h\x1b[2J\x1b[HFULL AGAIN");
    await t.page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("FULL AGAIN"));
    await moveTo(60, 3.2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await t.page.waitForTimeout(300);
    expect(t.inputs).toEqual([]);
  } finally {
    await t.context.close();
  }
}, 60_000);

test("phone: a program that just took the screen is asked about at once, not at the next snapshot", async () => {
  // The snapshot still shows the shell; a live read already finds Codex.
  const t = await openPlain({ phone: true, command: "zsh", first: SCREENS.normal });
  fixture.setLiveForeground(["codex"]);
  try {
    t.send("\x1b[?1049h\x1b[2J\x1b[HCODEX STARTED");
    await t.page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("CODEX STARTED"));
    await t.page.waitForTimeout(300);
    const line = t.fontSize * 1.16;
    const cdp = await t.context.newCDPSession(t.page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x, y: t.y }] });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y + i * line + 0.05 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await t.page.waitForTimeout(300);
    expect(kinds(t.inputs)).toEqual(["wheel-up"]);
  } finally {
    fixture.setLiveForeground(null);
    await t.context.close();
  }
}, 60_000);

test("phone: movement inside the long-press tolerance before a screen switch does not count after it", async () => {
  const t = await openPlain({ phone: true, command: "zsh", first: SCREENS.normal });
  try {
    const line = t.fontSize * 1.16;
    const cdp = await t.context.newCDPSession(t.page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x, y: t.y }] });
    // 8px: inside the 10px tolerance, so nothing moves yet.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y + 8 }] });
    t.send("\x1b[?1049h\x1b[2J\x1b[HFULL SCREEN VIEW");
    await t.page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("FULL SCREEN VIEW"));
    // Past the tolerance, but less than a line since the switch.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y + 8 + Math.min(9, line * 0.8) }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await t.page.waitForTimeout(300);
    expect([line > 9, t.inputs]).toEqual([true, []]);
  } finally {
    await t.context.close();
  }
}, 60_000);
