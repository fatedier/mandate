import { expect, test } from "bun:test";
import { threadChatInSight } from "../../src/client/routes/threads/thread-chat-sight.js";

// Whether a thread page has its own chat on screen: not behind a maximized
// panel, a narrow row's panel side, or a phone's sheet.

const desk = { phone: false, panelOpen: true, maximized: null, narrow: false, narrowView: "chat", sheet: "closed" } as const;

test("on a wide window the chat is in sight beside the panel, or alone; not behind a maximized panel", () => {
  expect(threadChatInSight(desk)).toBe(true);
  expect(threadChatInSight({ ...desk, panelOpen: false })).toBe(true);
  expect(threadChatInSight({ ...desk, maximized: "panel" })).toBe(false);
  // Maximize kept while the panel is closed: the chat has the row.
  expect(threadChatInSight({ ...desk, panelOpen: false, maximized: "panel" })).toBe(true);
});

test("a narrow row shows one side: the chat's, or the panel's in its place", () => {
  expect(threadChatInSight({ ...desk, narrow: true, narrowView: "chat" })).toBe(true);
  expect(threadChatInSight({ ...desk, narrow: true, narrowView: "panel" })).toBe(false);
  expect(threadChatInSight({ ...desk, narrow: true, narrowView: "panel", panelOpen: false })).toBe(true);
});

test("on a phone the chat is in sight only with the sheet closed", () => {
  const phone = { ...desk, phone: true };
  expect(threadChatInSight(phone)).toBe(true);
  expect(threadChatInSight({ ...phone, sheet: "half" })).toBe(false);
  expect(threadChatInSight({ ...phone, sheet: "full" })).toBe(false);
  // The desktop's maximize does not reach the phone layout.
  expect(threadChatInSight({ ...phone, maximized: "panel" })).toBe(true);
});
