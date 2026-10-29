import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser";
import { attachPageDiagnostics } from "./helpers/page-diagnostics";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { kinds, SCREENS } from "./helpers/terminal-scroll";

/**
 * Where a scroll over the terminal goes, on a desktop wheel and a phone drag,
 * in real Chromium with the production xterm: the test stands in for the
 * server end of /api/terminal and records what reaches the program.
 *
 * On the normal screen a scroll moves the terminal's own history. In the
 * alternate screen a full-screen program owns the screen: xterm sends it
 * arrows, or wheel reports when it asked for the mouse, and a phone drag does
 * the same. Codex reads wheel reports without asking and takes an arrow as
 * its previous prompt, so it gets wheel reports on both.
 */

let fixture: ReturnType<typeof startWorkspaceFixture>;
const browser = browserForFile();
beforeAll(async () => {
  fixture = startWorkspaceFixture();
});
afterAll(async () => {
  fixture?.stop();
});

const DRAG_PX = 300;
const WHEEL_PX = 240;

type Device = "desktop" | "phone";

/** A drag made of `steps` moves of exactly `linesPerStep` lines each, by the
 *  line height the touch handler counts in (the font size × 1.16). */
interface ExactDrag { steps: number; linesPerStep: number }

async function scrollUp(device: Device, command: string, screen: keyof typeof SCREENS, exact?: ExactDrag) {
  fixture.setTerminalPane(true, command);
  const phone = device === "phone";
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  attachPageDiagnostics(page);
  const inputs: string[] = [];
  await page.routeWebSocket("**/api/terminal?*", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "input") inputs.push(message.data);
    });
    socket.send(SCREENS[screen]);
  });
  try {
    await page.goto(fixture.baseUrl + WORKER_PATH + "/pane/%250");
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").length > 10);
    await page.waitForTimeout(300);
    const before = await firstRow(page);
    const cellHeight = await page.evaluate(() => {
      const screen = document.querySelector(".xterm-screen")!.getBoundingClientRect();
      return screen.height / document.querySelectorAll(".xterm-rows > div").length;
    });
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.3;
    if (phone) {
      // A slow finger drag downward, which scrolls up.
      const cdp = await context.newCDPSession(page);
      const fontSize = await page.locator(".xterm-rows").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      const steps = exact?.steps ?? 15;
      const stepPx = exact ? exact.linesPerStep * fontSize * 1.16 + 0.05 : DRAG_PX / steps;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= steps; i += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + stepPx * i }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, -WHEEL_PX);
    }
    await page.waitForTimeout(400);
    return {
      moved: (await firstRow(page)) !== before,
      inputs: kinds(inputs),
      count: inputs.length,
      // Lines the gesture travelled, by the terminal's own row height.
      lines: (phone ? DRAG_PX : WHEEL_PX) / cellHeight
    };
  } finally {
    await context.close();
  }
}

const firstRow = (page: Page) =>
  page.locator(".xterm-rows > div").first().evaluate((el) => (el.textContent ?? "").trim());

/** A count within 40% of what the travel calls for: loose enough for
 *  pixels, tight enough to catch a report per line where one per three is due. */
function expectAbout(count: number, expected: number) {
  expect([count, count >= Math.max(1, Math.floor(expected * 0.6)) && count <= Math.ceil(expected * 1.4)]).toEqual([count, true]);
}

for (const device of ["desktop", "phone"] as const) {
  test(`${device}: on the normal screen a scroll moves the history and sends nothing, codex or not`, async () => {
    for (const command of ["zsh", "codex"]) {
      const result = await scrollUp(device, command, "normal");
      expect([command, result.moved, result.inputs]).toEqual([command, true, []]);
    }
  }, 60_000);

  test(`${device}: a full-screen program that did not ask for the mouse gets arrows, X10 mouse or none`, async () => {
    for (const screen of ["alternate", "x10"] as const) {
      const result = await scrollUp(device, "zsh", screen);
      expect([screen, result.moved, result.inputs]).toEqual([screen, false, ["up-arrow"]]);
      // A desktop wheel event is one arrow from xterm; a drag, one per line.
      if (device === "desktop") expect(result.count).toBe(1);
      else expectAbout(result.count, result.lines);
    }
  }, 60_000);

  test(`${device}: a program that asked for the mouse gets wheel reports`, async () => {
    const result = await scrollUp(device, "zsh", "mouse");
    expect([result.moved, result.inputs]).toEqual([false, ["wheel-up"]]);
    if (device === "desktop") expect(result.count).toBe(1);
    else expectAbout(result.count, result.lines / 3);
  }, 60_000);

  test(`${device}: codex full screen gets wheel reports, never the arrow that recalls a prompt`, async () => {
    const result = await scrollUp(device, "codex", "alternate");
    expect([result.moved, result.inputs]).toEqual([false, ["wheel-up"]]);
    // One report per three lines of travel, on the wheel as on a drag.
    expectAbout(result.count, result.lines / 3);
  }, 60_000);
}

test("phone: a drag made of two-line moves still sends one wheel report per three lines", async () => {
  // 12 moves of 2 lines: 24 lines, 8 reports. Each forwarded report must not
  // cost the line of travel left over for the next one.
  const result = await scrollUp("phone", "zsh", "mouse", { steps: 12, linesPerStep: 2 });
  expect([result.inputs, result.count]).toEqual([["wheel-up"], 8]);
}, 60_000);
