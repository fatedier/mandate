import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import { artifactDir } from "./helpers/diagnostics.js";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { settle } from "./helpers/settle.js";

/**
 * An opened run of tool calls, measured and dragged in real Chromium: happy-dom
 * does no layout and has no pointer handling.
 *
 * The thin line that joins one call's mark to the next is placed by absolute
 * offsets against the row, so whether it starts under one mark and stops above
 * the next is only checked here: on a desktop with a call's details open
 * between two marks, and in the phone sheet.
 *
 * The phone's bottom sheet, dragged by a real pointer, is vaul's pointer
 * handling plus the release rule on top of it. Drags are slow on purpose: vaul
 * closes on a fast flick by itself; the slow pull down is the case that used to
 * spring back to half instead of closing.
 */

let server: RunningServer;
const browser = browserForFile();
let threadId = "";
let failedThreadId = "";

const CALLS = [
  { toolCallId: "call-read", toolName: "read", args: { path: "/repo/package.json" }, result: "{\n  \"name\": \"demo\"\n}" },
  { toolCallId: "call-bash", toolName: "bash", args: { command: "bun test", description: "Run the unit tests" }, result: "stdout:\nok\nexitCode: 0" },
  {
    toolCallId: "call-edit",
    toolName: "edit",
    args: { path: "/repo/build.ts", oldString: "old 0", newString: "new 0\nnew 1" },
    result: "Updated /repo/build.ts (1 replacement, +2 -1 lines)."
  }
];

/** A run like the one that showed the cut on a phone: two kinds
 *  of work to name, lines changed, calls the tally does not name, and a call
 *  that failed. */
const FAILED_RUN: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown>; result?: string; error?: string }> = [
  {
    toolCallId: "f-edit",
    toolName: "edit",
    args: { path: "/repo/limit.go", oldString: "old 0", newString: Array.from({ length: 42 }, (_, i) => `new ${i}`).join("\n") },
    result: "Updated /repo/limit.go (1 replacement, +42 -0 lines)."
  },
  { toolCallId: "f-vet", toolName: "bash", args: { command: "go vet ./..." }, result: "stdout:\nok\nexitCode: 0" },
  { toolCallId: "f-test", toolName: "bash", args: { command: "go test ./..." }, error: "exit 1" },
  ...Array.from({ length: 2 }, (_, i) => ({ toolCallId: `f-keys-${i}`, toolName: "send_keys", args: { paneId: "%1", keys: "y" }, result: "sent" })),
  ...Array.from({ length: 9 }, (_, i) => ({ toolCallId: `f-read-${i}`, toolName: "read", args: { path: `/repo/file-${i}.go` }, result: "package main" })),
  ...Array.from({ length: 4 }, (_, i) => ({ toolCallId: `f-pane-${i}`, toolName: "read_pane", args: { paneId: "%1" }, result: "$ " })),
  ...Array.from({ length: 3 }, (_, i) => ({ toolCallId: `f-plan-${i}`, toolName: "update_plan", args: { steps: [] }, result: "ok" }))
];

function seed(dataDir: string): void {
  const store = new MandateStore(dataDir);
  try {
    const agent = new AgentStore(store.db);
    const thread = agent.latestManagerThread("Build it");
    threadId = thread.id;
    agent.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Build it" }, wakeId: null });
    agent.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "self",
      wakeId: "wake-connector",
      content: {
        type: "assistant",
        text: "Building.",
        toolCalls: CALLS.map(({ toolCallId, toolName, args }) => ({ toolCallId, toolName, args }))
      }
    });
    for (const call of CALLS) {
      agent.appendMessage({
        threadId: thread.id,
        role: "tool",
        source: "self",
        wakeId: "wake-connector",
        content: { type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName, result: call.result }
      });
    }

    const failed = agent.createManagerThread("Limit the close");
    failedThreadId = failed.id;
    agent.appendMessage({ threadId: failed.id, role: "user", source: "user", content: { type: "text", text: "Limit the close" }, wakeId: null });
    agent.appendMessage({
      threadId: failed.id,
      role: "assistant",
      source: "self",
      wakeId: "wake-failed",
      content: {
        type: "assistant",
        text: "Limiting.",
        toolCalls: FAILED_RUN.map(({ toolCallId, toolName, args }) => ({ toolCallId, toolName, args }))
      }
    });
    for (const call of FAILED_RUN) {
      agent.appendMessage({
        threadId: failed.id,
        role: "tool",
        source: "self",
        wakeId: "wake-failed",
        content: call.error
          ? { type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName, error: call.error, isError: true }
          : { type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName, result: call.result }
      });
    }
  } finally {
    store.db.close();
  }
}

beforeAll(async () => {
  server = await startServer({ configured: true, seed });
});

afterAll(() => {
  server?.cleanup();
});

interface Box { top: number; bottom: number; centre: number }

/** Each call's mark, and the connector under it (null under the last). */
async function measure(page: Page, root: string): Promise<{ marks: Box[]; lines: (Box | null)[] }> {
  return page.evaluate((rootSelector) => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, centre: r.left + r.width / 2 };
    };
    const calls = [...document.querySelectorAll(`${rootSelector} [data-slot="tool-call"]`)];
    return {
      marks: calls.map((call) => box(call.querySelector('[data-slot="call-status"] svg')!)),
      lines: calls.map((call) => {
        const line = call.querySelector('[data-slot="call-connector"]');
        return line ? box(line) : null;
      })
    };
  }, root);
}

function expectJoined({ marks, lines }: { marks: Box[]; lines: (Box | null)[] }) {
  expect(marks.length).toBe(CALLS.length);
  expect(lines.map((line) => line !== null)).toEqual([true, true, false]);
  for (let i = 0; i < marks.length - 1; i += 1) {
    const line = lines[i]!;
    // Centred under both marks, starting 3px below this one and stopping 3px
    // above the next.
    expect(Math.abs(line.centre - marks[i]!.centre)).toBeLessThan(0.75);
    expect(Math.abs(line.centre - marks[i + 1]!.centre)).toBeLessThan(0.75);
    expect(line.top - marks[i]!.bottom).toBeCloseTo(3, 0);
    expect(marks[i + 1]!.top - line.bottom).toBeCloseTo(3, 0);
  }
}

test("on a desktop the line runs from each mark to the next, past a call's open details", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.locator('[data-slot="tool-run-line"]').first().click();
    await page.waitForSelector('[data-slot="tool-run-calls"]');
    expectJoined(await measure(page, '[data-slot="tool-run-calls"]'));

    // The first call's details open between its mark and the next one's.
    await page.locator('[data-slot="tool-run-calls"] [data-slot="tool-call"]').first().click();
    await page.waitForSelector('[data-slot="tool-run-calls"] [data-slot="tool-details"]');
    // The details grow open: measure once they have.
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-slot="fold"]')).every((el) => el.getAnimations().length === 0));
    const opened = await measure(page, '[data-slot="tool-run-calls"]');
    expect(opened.marks[1]!.top - opened.marks[0]!.bottom).toBeGreaterThan(40);
    expectJoined(opened);
    await page.locator('[data-slot="tool-run"]').first().screenshot({ path: path.join(artifactDir("tool-call-connector"), "desktop.png") });
  } finally {
    await context.close();
  }
}, 60000);

test("in the phone sheet the line runs from each mark to the next", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.locator('[data-slot="tool-run-line"]').first().click();
    await page.waitForSelector('[data-slot="tool-sheet"] [data-slot="tool-call"]');
    await settle(page);
    expectJoined(await measure(page, '[data-slot="tool-sheet"]'));
    await page.screenshot({ path: path.join(artifactDir("tool-call-connector"), "phone.png") });
  } finally {
    await context.close();
  }
}, 60000);

async function openChat(page: Page, id = threadId) {
  await page.goto(`${server.baseUrl}/threads/${id}`);
  await page.waitForSelector('[data-slot="tool-run-line"]', { timeout: 15000 });
}

/** What the run's line draws: the clauses on screen, the count, the lines
 *  changed and the failures if they are, and whether what is left of the
 *  tally is still cut. */
async function lineDraws(page: Page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-slot="tool-run-line"]')!;
    const drawn = (el: Element | null) => el !== null && el.getClientRects().length > 0;
    const tally = line.querySelector<HTMLElement>('[data-slot="tool-run-tally"]')!;
    const shown = (slot: string) => {
      const el = line.querySelector(`[data-slot="${slot}"]`);
      return drawn(el) ? el!.textContent : null;
    };
    return {
      clauses: [...line.querySelectorAll('[data-slot="tool-run-clause"]')].filter(drawn).map((clause) => clause.textContent),
      count: shown("tool-run-count"),
      lines: shown("line-counts"),
      failed: shown("tool-run-failed"),
      cut: tally.scrollWidth > tally.clientWidth
    };
  });
}

// The narrow rules are container queries, which happy-dom does not apply.
test("a run's line names all three of its kinds of work in a wide pane, and two and a count in a narrow one", async () => {
  const widths = [
    { width: 1280, height: 900, draws: { clauses: ["Edited 1 file", ", ran 1 command", ", read 1 file"], count: null, lines: "+2 −1", failed: null, cut: false } },
    { width: 390, height: 844, draws: { clauses: ["Edited 1 file", ", ran 1 command"], count: "· 3 calls", lines: "+2 −1", failed: null, cut: false } }
  ];
  for (const { width, height, draws } of widths) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    attachPageDiagnostics(page);
    try {
      await openChat(page);
      expect(await lineDraws(page)).toEqual(draws);
    } finally {
      await context.close();
    }
  }
}, 60000);

// With "· 1 failed" on the line a phone has no room for the line counts too:
// the second clause was cut mid-word ("ran 2 comm…"). The counts leave the
// line there; a wide pane keeps everything.
test("on a phone a run that reports a failure keeps its two clauses whole and leaves out the line counts", async () => {
  const widths = [
    {
      width: 1280,
      height: 900,
      draws: { clauses: ["Edited 1 file", ", ran 2 commands", ", sent keys 2 times", ", read 9 files"], count: "· 21 calls", lines: "+42 −0", failed: "· 1 failed", cut: false }
    },
    { width: 390, height: 844, draws: { clauses: ["Edited 1 file", ", ran 2 commands"], count: "· 21 calls", lines: null, failed: "· 1 failed", cut: false } }
  ];
  for (const { width, height, draws } of widths) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    attachPageDiagnostics(page);
    try {
      await openChat(page, failedThreadId);
      expect(await lineDraws(page)).toEqual(draws);
    } finally {
      await context.close();
    }
  }
}, 60000);

/** Twelve steps of 100ms: slow enough that vaul sees no flick. */
async function slowDrag(page: Page, dy: number) {
  const box = (await page.locator("[data-vaul-handle]").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(x, y + (dy * i) / 12);
    await page.waitForTimeout(100);
  }
  await page.mouse.up();
  await settle(page);
}

test("a phone sheet rests at half, pulls up to full, and closes on a slow pull down", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  attachPageDiagnostics(page);
  const sheet = page.locator('[data-slot="tool-sheet"]');
  const openSheet = async () => {
    await page.locator('[data-slot="tool-run-line"]').first().click();
    await sheet.waitFor();
    await settle(page);
  };
  const handleTop = async () => (await page.locator("[data-vaul-handle]").boundingBox())!.y;
  try {
    await openChat(page);
    await openSheet();
    expect(await sheet.getAttribute("data-expanded")).toBe("false");
    const half = await handleTop();
    // Half: the handle near the middle of the 844px screen.
    expect(half).toBeGreaterThan(844 * 0.4);
    expect(half).toBeLessThan(844 * 0.6);
    expect(await page.evaluate(() => document.activeElement === document.querySelector('[data-slot="tool-sheet"]'))).toBe(true);

    // Tapping a call opens its details and leaves the sheet at half: a tap
    // focuses the row, and only keyboard focus pulls the sheet up.
    await page.locator('[data-slot="tool-sheet"] [data-slot="tool-call"]').first().click();
    await settle(page);
    expect(await sheet.getAttribute("data-expanded")).toBe("false");
    expect(await page.locator('[data-slot="tool-sheet"] [data-slot="tool-details"]').count()).toBe(1);

    // A short pull springs back to half. A close flips data-state at the
    // release, before its slide out, so "open" here is not just "not yet gone".
    await slowDrag(page, 80);
    expect(await sheet.getAttribute("data-state")).toBe("open");
    expect(Math.round(await handleTop())).toBe(Math.round(half));

    // A long one closes: under 35% of the screen would be showing.
    await slowDrag(page, 220);
    await sheet.waitFor({ state: "detached" });

    // Up to full, then down again to half, not closed.
    await openSheet();
    await slowDrag(page, -420);
    expect(await sheet.getAttribute("data-expanded")).toBe("true");
    expect(await handleTop()).toBeLessThan(844 * 0.1);
    await slowDrag(page, 250);
    expect(await sheet.getAttribute("data-state")).toBe("open");
    expect(await sheet.getAttribute("data-expanded")).toBe("false");
  } finally {
    await context.close();
  }
}, 90000);
