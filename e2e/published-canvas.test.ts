import { expect, test } from "bun:test";
import type { AgentClientMessageDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { PHONE } from "./helpers/touch-targets";

// A canvas a step published is one line under its tool run. On a phone, a
// title longer than the chat's width is cut short with the arrow still in
// view, inside the chat's column: the chat clips what sticks out sideways, so
// a line wider than its column would lose its end unseen. Widths are the
// browser's, which happy-dom has none of.

const browser = browserForFile();
const TITLE = "Implementation plan for the canvas publishing workflow and its review steps";
const row = { threadId: "zoom-thread", sourceThreadId: null, createdAt: "2026-09-13T00:00:00.000Z" } as const;

test("on a phone a published canvas's line keeps within the chat's column, its long title cut short", async () => {
  const fixture = startWorkspaceFixture();
  const messages: AgentClientMessageDto[] = [
    { ...row, wakeId: null, id: "m-1", seq: 1, role: "user", source: "user", content: { type: "text", text: "Write the plan up." } },
    { ...row, wakeId: "wake_1", id: "m-2", seq: 2, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call-1", toolName: "canvas", args: { action: "publish", canvasId: "cnv_e2ePublished" } }] } },
    { ...row, wakeId: "wake_1", id: "m-3", seq: 3, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "call-1", toolName: "canvas", result: { ok: true, canvasId: "cnv_e2ePublished", title: TITLE, path: "/canvas/cnv_e2ePublished" } } },
    { ...row, wakeId: "wake_1", id: "m-4", seq: 4, role: "assistant", source: "self", content: { type: "assistant", text: "The plan is up." } }
  ] as AgentClientMessageDto[];
  fixture.setMessages(messages);
  const context = await browser.newContext(PHONE);
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}${workerPath("chat")}`);
    const line = page.locator('[data-slot="published-canvas"]');
    await line.waitFor();
    const fit = await line.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const column = el.parentElement!.getBoundingClientRect();
      const title = el.querySelector("span")!;
      // Its end: the left edge sits a hair outside on purpose (the icon lines up with the text).
      return { inColumn: box.right <= column.right + 1, onScreen: box.right <= window.innerWidth, cut: title.scrollWidth > title.clientWidth };
    });
    expect(fit).toEqual({ inColumn: true, onScreen: true, cut: true });
  } finally {
    await context.close();
    fixture.stop();
  }
});
