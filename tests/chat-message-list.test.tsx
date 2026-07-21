import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessageList } from "../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, type ThreadState } from "../src/client/store/agent-chat.js";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import { featureMessageReplyMetadata } from "../src/shared/feature-message.js";

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

test("ChatMessageList renders restart recovery as a compact system event", async () => {
  const thread = makeThread({
    id: "recovery-1", threadId: "thr-1", seq: 1, role: "user", source: "restart-recovery",
    sourceThreadId: null, wakeId: "wake-recovered",
    createdAt: "2026-09-15T00:00:00Z",
    content: { type: "text", text: "Inspect saved progress before continuing." }
  });
  const view = await renderList(thread);
  try {
    expect(view.container.textContent).toContain("RECOVERY");
    expect(view.container.textContent).toContain("checking progress and continuing");
    expect(view.container.textContent).not.toContain("Inspect saved progress before continuing.");
  } finally { await view.cleanup(); }
});

test("ChatMessageList renders a selected work item and the user's message body", async () => {
  seedWorkItem();
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "user",
    sourceThreadId: null,
    wakeId: null,
    content: {
      type: "text",
      text: "Can you check whether this is config-only?",
      metadata: { workItemRef: { itemId: "wi-1", snapshotAt: "2026-05-28T00:00:00Z" } }
    },
    createdAt: "2026-05-28T00:00:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("LiteLLM passthrough review");
    expect(container.textContent).toContain("Can you check whether this is config-only?");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList keeps auto-promoted work item messages as a card only", async () => {
  seedWorkItem();
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "user",
    sourceThreadId: null,
    wakeId: null,
    content: {
      type: "text",
      text: "📌 [Work item: LiteLLM passthrough review]\nStored work item summary",
      metadata: { workItemRef: { itemId: "wi-1", snapshotAt: "2026-05-28T00:00:00Z" } }
    },
    createdAt: "2026-05-28T00:00:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("LiteLLM passthrough review");
    expect(container.textContent).not.toContain("📌 [Work item:");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList renders heartbeat wake provenance with assistant replies", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "assistant",
    source: "self",
    sourceThreadId: null,
    wakeId: "wake-1",
    wakeReason: "work-item-heartbeat",
    content: {
      type: "assistant",
      text: "No blockers right now."
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("HEARTBEAT");
    expect(container.textContent).toContain("[work-item]");
    expect(container.textContent).toContain("auto · 30m · checked active items");
    expect(container.textContent).toContain("No blockers right now.");
    expect(container.textContent).not.toContain("Review");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList renders feature-event wake provenance with source metadata", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "assistant",
    source: "self",
    sourceThreadId: null,
    wakeId: "wake-1",
    wakeReason: "feature-event",
    wakeMetadata: {
      featureEvents: [{
        type: "feature_event",
        kind: "completion",
        taskId: "task-1",
        featureId: "feat-1",
        workItemId: "wi-1",
        source: {
          project: { id: "proj-1", name: "Mandate" },
          feature: { id: "feat-1", name: "Event source display" },
          workItem: { id: "wi-1", title: "Implement source labels" },
          capturedAt: "2026-05-28T00:00:00Z"
        },
        label: "Implement source labels",
        summary: "Done."
      }]
    },
    content: {
      type: "assistant",
      text: "I picked up the completed task."
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("FEATURE");
    expect(container.textContent).toContain("[task]");
    expect(container.textContent).toContain("Mandate / Event source display · completed");
    expect(container.textContent).toContain("I picked up the completed task.");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList renders feature conversation messages separately from user input", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "feature-message",
    sourceThreadId: "feature-thread",
    wakeId: null,
    content: {
      type: "text",
      text: "The parser stays incremental.",
      metadata: featureMessageReplyMetadata({
        featureId: "feat-1",
        featureName: "Parser"
      })
    },
    createdAt: "2026-07-13T00:00:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("feature");
    expect(container.textContent).toContain("Parser");
    expect(container.textContent).toContain("The parser stays incremental.");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList keeps legacy feature-event wake provenance fallback", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "assistant",
    source: "self",
    sourceThreadId: null,
    wakeId: "wake-1",
    wakeReason: "feature-event",
    content: {
      type: "assistant",
      text: "Legacy wake reply."
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("FEATURE");
    expect(container.textContent).toContain("[task]");
    expect(container.textContent).toContain("event · feature task update");
    expect(container.textContent).toContain("Legacy wake reply.");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList does not repeat watch wake provenance on assistant replies", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "assistant",
    source: "self",
    sourceThreadId: null,
    wakeId: "wake-1",
    wakeReason: "watch",
    content: {
      type: "assistant",
      text: "The watched pane is ready."
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).not.toContain("WATCH");
    expect(container.textContent).not.toContain("agent resumed from watch_window");
    expect(container.textContent).toContain("The watched pane is ready.");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList renders watch system events with pane and note detail", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "watch",
    sourceThreadId: null,
    wakeId: null,
    wakeReason: null,
    content: {
      type: "text",
      text: [
        "[Mandate watch_window event]",
        "windowKey: local:md-test:feature",
        "paneId: %413",
        "stableMs: 30000",
        "result: settled",
        "note: Verify web/frps npm run type-check after serverinfo v2 implementation"
      ].join("\n")
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("WATCH");
    expect(container.textContent).toContain("[pane]");
    expect(container.textContent).toContain(
      "pane %413 stable for 30s · Verify web/frps npm run type-check after serverinfo v2 implementation"
    );
  } finally {
    await cleanup();
  }
});

test("ChatMessageList shows non-watch wake provenance once per wake id", async () => {
  const thread = makeThread([
    {
      id: "msg-1",
      threadId: "thr-1",
      seq: 1,
      role: "assistant",
      source: "self",
      sourceThreadId: null,
      wakeId: "wake-1",
      wakeReason: "alarm",
      content: {
        type: "assistant",
        text: "First update from the scheduled wake."
      },
      createdAt: "2026-05-28T00:30:00Z"
    },
    {
      id: "msg-2",
      threadId: "thr-1",
      seq: 2,
      role: "assistant",
      source: "self",
      sourceThreadId: null,
      wakeId: "wake-1",
      wakeReason: "alarm",
      content: {
        type: "assistant",
        text: "Second update in the same wake."
      },
      createdAt: "2026-05-28T00:31:00Z"
    }
  ]);

  const { container, cleanup } = await renderList(thread);
  try {
    const text = container.textContent ?? "";
    expect((text.match(/fired · scheduled wake/g) ?? [])).toHaveLength(1);
    expect(text).toContain("First update from the scheduled wake.");
    expect(text).toContain("Second update in the same wake.");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList keeps alarm notes visible in provenance rows", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "alarm",
    sourceThreadId: null,
    wakeId: "wake-1",
    wakeReason: "alarm",
    content: {
      type: "text",
      text: [
        "[Mandate alarm fired]",
        "alarmId: alm-1",
        "scheduled at: 2026-05-28T12:00:00Z",
        "fired at: 2026-05-28T12:30:00Z",
        "note: Check the build result after lunch."
      ].join("\n")
    },
    createdAt: "2026-05-28T12:30:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("ALARM");
    expect(container.textContent).toContain("[scheduled]");
    expect(container.textContent).toContain("note: Check the build result after lunch.");
  } finally {
    await cleanup();
  }
});

test("ChatMessageList collapses runtime context into provenance metadata", async () => {
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "runtime-context",
    sourceThreadId: null,
    wakeId: "wake-1",
    wakeReason: "work-item-heartbeat",
    content: {
      type: "text",
      text: "[runtime_context]\nRAW WORK ITEM SNAPSHOT",
      metadata: { runtimeContextKind: "update" }
    },
    createdAt: "2026-05-28T00:30:00Z"
  });

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.textContent).toContain("CONTEXT");
    expect(container.textContent).toContain("[runtime_context]");
    expect(container.textContent).toContain("snapshot");
    expect(container.textContent).not.toContain("RAW WORK ITEM SNAPSHOT");
  } finally {
    await cleanup();
  }
});

test("the transcript establishes the container context its narrow rules resolve against", async () => {
  // Every narrow rule inside the transcript is a `@max-[34rem]:` MAX-width
  // rule, so it is the NARROW layout that is opt-in and the wide layout is the
  // unprefixed classes. Delete this class and there is no query container to
  // resolve against, so no narrow rule ever matches: a 900px dock is unaffected
  // and a 320px dock silently renders the wide layout — i.e. the whole of this
  // work no-ops exactly where it was needed, without a single test failing
  // elsewhere. (Before the inversion the failure went the other way, wide
  // everywhere becoming narrow everywhere; that direction no longer applies.)
  // happy-dom evaluates no container queries, so this pins the class only; the
  // layout itself is verified in a browser.
  const thread = makeThread({
    id: "msg-1",
    threadId: "thr-1",
    seq: 1,
    role: "user",
    source: "user",
    sourceThreadId: null,
    wakeId: null,
    content: { type: "text", text: "hello" },
    createdAt: "2026-05-28T00:00:00Z"
  });
  const { container, cleanup } = await renderList(thread);
  try {
    const scroller = container.querySelector("[class*='overflow-y-auto']")!;
    const wrapper = scroller.parentElement!;
    expect(wrapper.className.split(/\s+/)).toContain("@container");
    // The scroller must NOT be the container: `@container` implies
    // `contain: layout inline-size`, and this element owns scroll position.
    expect(scroller.className.split(/\s+/)).not.toContain("@container");
    // Scroll anchoring off — the browser otherwise fires a phantom scroll
    // during any reflow, which unpins a transcript that was following.
    expect(scroller.className.split(/\s+/)).toContain("[overflow-anchor:none]");
  } finally {
    await cleanup();
  }
});

test("consecutive tool durations start at the preceding completed event", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:02.000"),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:03.200")
  ]);

  const { container, cleanup } = await renderList(thread);
  try {
    const durations = [...container.querySelectorAll('[data-slot="tool-duration"]')].map(
      (element) => element.textContent
    );
    expect(durations).toEqual(["2.0s", "1.2s"]);
    expect(durations).not.toContain("3.2s");
    expect(container.querySelector('[data-slot="tool-time"]')).toBeNull();
    expect(container.textContent?.match(/10:04:00/g) ?? []).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

test("a fast non-first tool stays hidden instead of inheriting prior tool time", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:07.800"),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:08.250")
  ]);

  const { container, cleanup } = await renderList(thread);
  try {
    const durations = [...container.querySelectorAll('[data-slot="tool-duration"]')].map(
      (element) => element.textContent
    );
    expect(durations).toEqual(["7.8s"]);
    expect(container.textContent).not.toContain("8.3s");
  } finally {
    await cleanup();
  }
});

test("a missing prior result leaves later tool duration unknown", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:03.000")
  ]);

  const { container, cleanup } = await renderList(thread);
  try {
    expect(container.querySelector('[data-slot="tool-duration"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

test("cross-day messages render visible date boundaries and semantic clocks", async () => {
  const firstAt = "2026-08-02T23:59:58.000";
  const secondAt = "2026-08-03T00:00:02.000";
  const thread = makeThread([
    userMessage(1, firstAt, "Before midnight"),
    assistantMessage(2, secondAt, [], "After midnight")
  ]);

  const { container, cleanup } = await renderList(thread);
  try {
    const separators = [...container.querySelectorAll('[role="separator"] time')];
    expect(separators.map((element) => element.textContent)).toEqual([
      "02 Aug 2026",
      "03 Aug 2026"
    ]);
    for (const [clock, timestamp] of [
      ["23:59:58", firstAt],
      ["00:00:02", secondAt]
    ]) {
      const element = [...container.querySelectorAll("time")].find(
        (candidate) => candidate.textContent === clock
      );
      expect(element?.getAttribute("datetime")).toBe(timestamp);
    }
  } finally {
    await cleanup();
  }
});

test("one assistant step with tools shows a single absolute clock", async () => {
  const thread = makeThread([
    assistantMessage(1, "2026-08-02T10:04:00.000", ["call-1", "call-2"]),
    toolResultMessage(2, "call-1", "2026-08-02T10:04:02.000"),
    toolResultMessage(3, "call-2", "2026-08-02T10:04:05.000")
  ]);

  const { container, cleanup } = await renderList(thread);
  try {
    // Both tools are slow enough to be labelled, so this counts clocks in a row
    // that still carries two durations — the durations are not clocks.
    const clocks = container.textContent?.match(/\d{2}:\d{2}:\d{2}/g) ?? [];
    expect(clocks).toEqual(["10:04:00"]);
    expect(
      [...container.querySelectorAll('[data-slot="tool-duration"]')].map((el) => el.textContent)
    ).toEqual(["2.0s", "3.0s"]);
  } finally {
    await cleanup();
  }
});

test("a date separator is never anchored to a row the transcript hides", async () => {
  // `ensureSystemMessage` seeds seq 0 with a hidden `role: "system"` row, and a
  // thread opened the day before its first real message would otherwise print a
  // heading over an empty stretch — and then suppress the heading the first
  // visible message actually needed.
  const thread = makeThread([
    systemMessage(0, "2026-08-01T22:00:00.000"),
    userMessage(1, "2026-08-02T09:00:00.000", "Morning after")
  ]);

  const { container, cleanup } = await renderList(thread);
  try {
    const separators = [...container.querySelectorAll('[role="separator"]')];
    expect(separators.map((el) => el.getAttribute("aria-label"))).toEqual(["02 Aug 2026"]);
    expect(separators[0]?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-02T09:00:00.000"
    );
    expect(container.textContent).not.toContain("01 Aug 2026");
  } finally {
    await cleanup();
  }
});

type ChatMessage = ThreadState["messages"][number];

function assistantMessage(
  seq: number,
  createdAt: string,
  toolCallIds: string[],
  text = "Using tools"
): ChatMessage {
  return {
    id: `assistant-${seq}`,
    threadId: "thr-1",
    seq,
    role: "assistant",
    source: "self",
    sourceThreadId: null,
    wakeId: null,
    content: {
      type: "assistant",
      text,
      toolCalls: toolCallIds.map((toolCallId, index) => ({
        toolCallId,
        toolName: `tool_${index + 1}`,
        args: { value: index + 1 }
      }))
    },
    createdAt
  };
}

function toolResultMessage(seq: number, toolCallId: string, createdAt: string): ChatMessage {
  return {
    id: `tool-${seq}`,
    threadId: "thr-1",
    seq,
    role: "tool",
    source: "self",
    sourceThreadId: null,
    wakeId: null,
    content: {
      type: "tool_result",
      toolCallId,
      toolName: toolCallId,
      result: "ok"
    },
    createdAt
  };
}

function systemMessage(seq: number, createdAt: string): ChatMessage {
  return {
    id: `system-${seq}`,
    threadId: "thr-1",
    seq,
    role: "system",
    source: "self",
    sourceThreadId: null,
    wakeId: null,
    content: { type: "text", text: "You are the manager agent." },
    createdAt
  };
}

function userMessage(seq: number, createdAt: string, text: string): ChatMessage {
  return {
    id: `user-${seq}`,
    threadId: "thr-1",
    seq,
    role: "user",
    source: "user",
    sourceThreadId: null,
    wakeId: null,
    content: { type: "text", text },
    createdAt
  };
}

function seedWorkItem() {
  useWorkItemsStore.getState().upsert({
    id: "wi-1",
    title: "LiteLLM passthrough review",
    summary: "Review whether passthrough is config-only.",
    needsUser: "review",
    featureId: "feat-1",
    projectId: "proj-1",
    phase: "working",
    phaseDetail: null,
    canvasId: null,
    lastActivityAt: "2026-05-28T00:00:00Z",
    createdAt: "2026-05-28T00:00:00Z",
    updatedAt: "2026-05-28T00:00:00Z"
  } as any);
}

function makeThread(
  message: ThreadState["messages"][number] | ThreadState["messages"][number][]
): ThreadState {
  const messages = Array.isArray(message) ? message : [message];
  return {
    ...newThreadState(),
    threadId: "thr-1",
    messages,
    oldestSeqLoaded: messages[0]?.seq ?? 1
  };
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
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  };
}
