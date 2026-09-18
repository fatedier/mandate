import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { newThreadState, type ThreadState } from "@/store/agent-chat";
import { useWorkItemsStore } from "@/store/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(),
    paginationByStatus: new Map(),
    fetchDetail: async () => {}
  }, true);
});
afterEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(),
    paginationByStatus: new Map()
  }, true);
});

type Msg = ThreadState["messages"][number];

function makeThread(messages: Msg[]): ThreadState {
  return { ...newThreadState(), threadId: "thr-1", messages, oldestSeqLoaded: messages[0]?.seq ?? 1 };
}

async function renderList(thread: ThreadState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ChatMessageList
        thread={thread}
        onLoadOlder={async () => {}}
        onRetryFailed={() => {}}
        onDismissError={() => {}}
        onOpenWorkItem={() => {}}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  };
}

/** A heartbeat wake whose reply is empty — the no-op case that used to leave
 *  a provenance row plus a bare timestamp under it. */
function emptyHeartbeat(n: number): Msg {
  return {
    id: `msg-${n}`, threadId: "thr-1", seq: n, role: "assistant", source: "self", sourceThreadId: null,
    wakeId: `wake-${n}`, wakeReason: "work-item-heartbeat",
    content: { type: "assistant", text: "" },
    createdAt: `2026-05-28T0${n}:00:00Z`
  } as Msg;
}

function userMessage(): Msg {
  return {
    id: "msg-0", threadId: "thr-1", seq: 0, role: "user", source: "user", sourceThreadId: null, wakeId: null,
    content: { type: "text", text: "hello" }, createdAt: "2026-05-28T00:30:00Z"
  } as Msg;
}

test("three consecutive empty heartbeats fold into one row; Show expands them", async () => {
  const { container, cleanup } = await renderList(makeThread([userMessage(), emptyHeartbeat(1), emptyHeartbeat(2), emptyHeartbeat(3)]));
  try {
    const fold = container.querySelector('[data-slot="system-fold"]')!;
    expect(fold === null).toBe(false);
    expect(fold.textContent).toContain("3 heartbeats");
    expect(container.querySelectorAll('[data-slot="provenance-label"]').length).toBe(0);
    const button = fold.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { button.click(); });
    expect(container.querySelectorAll('[data-slot="provenance-label"]').length).toBe(3);
    expect(container.querySelector('[data-slot="system-fold"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    await cleanup();
  }
});

test("a single empty heartbeat stays a plain provenance row", async () => {
  const { container, cleanup } = await renderList(makeThread([userMessage(), emptyHeartbeat(1)]));
  try {
    expect(container.querySelector('[data-slot="system-fold"]') === null).toBe(true);
    expect(container.querySelectorAll('[data-slot="provenance-label"]').length).toBe(1);
    // and no orphan timestamp row under it (AssistantMessage renders nothing):
    // date separator + the user bubble's clock + the provenance clock, nothing else
    expect(container.querySelectorAll("time").length).toBe(3);
  } finally {
    await cleanup();
  }
});

/** A runtime-context snapshot: a user-role row that carries system
 *  provenance (CONTEXT), so it folds like a heartbeat does. */
function ctx(n: number): Msg {
  return {
    id: `ctx-${n}`, threadId: "thr-1", seq: n, role: "user", source: "runtime-context", sourceThreadId: null, wakeId: null,
    content: { type: "text", text: `snapshot ${n}`, metadata: { runtimeContextKind: "update" } },
    createdAt: `2026-05-28T0${n}:00:00Z`
  } as Msg;
}

test("consecutive user-role context snapshots fold into one row; Show expands them", async () => {
  const { container, cleanup } = await renderList(makeThread([userMessage(), ctx(1), ctx(2)]));
  try {
    const folds = container.querySelectorAll('[data-slot="system-fold"]');
    expect(folds.length).toBe(1);
    expect(folds[0]!.textContent).toContain("2 context snapshots");
    expect(container.querySelectorAll('[data-slot="provenance-label"]').length).toBe(0);
    const button = folds[0]!.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => { button.click(); });
    expect(container.querySelectorAll('[data-slot="provenance-label"]').length).toBe(2);
  } finally {
    await cleanup();
  }
});

test("heartbeats with real replies are not folded", async () => {
  const withText = (n: number): Msg => ({ ...emptyHeartbeat(n), content: { type: "assistant", text: `Reply ${n}.` } } as Msg);
  const { container, cleanup } = await renderList(makeThread([withText(1), withText(2)]));
  try {
    expect(container.querySelector('[data-slot="system-fold"]') === null).toBe(true);
    expect(container.textContent).toContain("Reply 1.");
    expect(container.textContent).toContain("Reply 2.");
  } finally {
    await cleanup();
  }
});

test("a reply under a provenance row does not repeat the clock; a plain reply keeps it", async () => {
  const heartbeatReply: Msg = { ...emptyHeartbeat(1), content: { type: "assistant", text: "No blockers." } } as Msg;
  const plainReply: Msg = {
    ...emptyHeartbeat(2), wakeReason: "user", wakeId: null,
    content: { type: "assistant", text: "Here is the answer." }
  } as Msg;
  const { container, cleanup } = await renderList(makeThread([userMessage(), heartbeatReply, plainReply]));
  try {
    // One provenance row (the heartbeat) carrying the only clock for that reply…
    expect(container.querySelectorAll('[data-slot="provenance-label"]').length).toBe(1);
    // …and exactly one assistant clock row, belonging to the plain reply.
    const clocks = container.querySelectorAll('[data-slot="assistant-clock"]');
    expect(clocks.length).toBe(1);
    expect(clocks[0]!.getAttribute("datetime")).toBe(plainReply.createdAt);
    expect(container.textContent).toContain("No blockers.");
    expect(container.textContent).toContain("Here is the answer.");
  } finally {
    await cleanup();
  }
});
