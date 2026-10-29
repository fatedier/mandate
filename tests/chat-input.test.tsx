import { expect, test } from "bun:test";
import { act } from "react";
import { ChatInput } from "../src/client/routes/window/chat/ChatInput.js";
import type { AgentChatScope } from "../src/client/store/agent-chat.js";
import { onCleanup } from "./helpers/cleanup.js";
import { mount as mountTree, mountAsync } from "./helpers/mount.js";

test("ChatInput: Enter during IME composition does not send", async () => {
  const sent: string[] = [];
  const originalGetComputedStyle = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = originalGetComputedStyle; });
  globalThis.getComputedStyle = (() => ({
    lineHeight: "20px"
  })) as unknown as typeof globalThis.getComputedStyle;

  const { host: container } = await mountAsync(<ChatInput onSend={(content) => sent.push(content)} />);

  const textarea = container.getElementsByTagName("textarea")[0]!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(textarea),
      "value"
    )?.set;
    setValue?.call(textarea, "nihao");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "nihao"
    }));
  });

  await act(async () => {
    textarea.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    }));
  });
  expect(sent).toStrictEqual([]);

  await act(async () => {
    textarea.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    }));
  });
  expect(sent).toStrictEqual([]);

  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    }));
  });
  expect(sent).toStrictEqual(["nihao"]);
});

test("ChatInput: busy send and queued tray remain interactive without working copy", async () => {
  const sent: string[] = [];
  const removed: string[] = [];
  const originalGetComputedStyle = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = originalGetComputedStyle; });
  globalThis.getComputedStyle = (() => ({
    lineHeight: "20px"
  })) as unknown as typeof globalThis.getComputedStyle;

  const { host: container, rerender } = await mountAsync(
    <ChatInput busyHint onCancel={() => {}} onSend={(content) => sent.push(content)} />
  );
  expect(container.textContent).not.toContain("Agent is working");
  expect(container.querySelector('button[aria-label="Stop agent"]')).not.toBeNull();

  const textarea = container.getElementsByTagName("textarea")[0]!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(textarea),
      "value"
    )?.set;
    setValue?.call(textarea, "guide the next step");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "guide the next step"
    }));
  });

  const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  expect(sendButton.disabled).toBe(false);
  expect(container.querySelector('button[aria-label="Stop agent"]') === null).toBe(true);
  await act(async () => {
    sendButton.click();
  });
  expect(sent).toStrictEqual(["guide the next step"]);

  rerender(
    <ChatInput
      busyHint
      onSend={() => {}}
      queuedMessages={[
        {
          localId: "local-queued",
          content: "queued hello",
          status: "queued",
          createdAt: "2026-08-01T00:00:00.000Z"
        },
        {
          localId: "local-queued-2",
          content: "queued again",
          status: "queued",
          createdAt: "2026-08-01T00:00:01.000Z"
        }
      ]}
      onDeleteQueuedMessage={(localId) => removed.push(localId)}
    />
  );
  expect(container.querySelector(".label-micro")?.textContent).toBe("Queued2");
  expect(container.textContent).toContain("queued hello");
  expect(container.textContent).toContain("queued again");
  expect(container.textContent).not.toContain("Agent is working");

  const removeButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove queued message"]'
  )!;
  await act(async () => {
    removeButton.click();
  });
  expect(removed).toStrictEqual(["local-queued"]);
});

function mount(props: { scope?: AgentChatScope }) {
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const view = mountTree(<ChatInput onSend={() => {}} scope={props.scope} />);
  return {
    container: view.host,
    unmount: () => {
      view.unmount();
      globalThis.getComputedStyle = originalGetComputedStyle;
    }
  };
}

test("ChatInput: the composer is a raised card with the send hint", async () => {
  const view = mount({ scope: { type: "manager", threadId: "thr_m" } });
  const card = view.container.querySelector('[data-slot="composer"]')!;
  expect(card === null).toBe(false);
  expect(card.className.split(/\s+/)).toContain("shadow-composer");
  expect(view.container.textContent).toContain("to send");
  expect(view.container.querySelector("textarea")?.style.maxHeight).toBe("calc(8lh + 0.25rem)");
  view.unmount();
});

/** Runs with `query` the one media query the window matches; null leaves the
 *  window as it is (a mouse and keyboard, 1024px wide). */
async function withMedia(query: string | null, run: () => Promise<void>) {
  if (query === null) return run();
  const realMatchMedia = window.matchMedia;
  window.matchMedia = ((asked: string) => ({
    media: asked,
    matches: asked === query,
    addEventListener() {},
    removeEventListener() {}
  })) as unknown as typeof window.matchMedia;
  try {
    await run();
  } finally {
    window.matchMedia = realMatchMedia;
  }
}

// A phone: its keyboard has Enter but no easy Shift+Enter, so Enter has to
// mean a new line there and the send button sends.
async function withTouchScreen(run: () => Promise<void>) {
  await withMedia("(pointer: coarse)", run);
}

async function typeInto(textarea: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set?.call(textarea, text);
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
}

function pressEnter(textarea: HTMLTextAreaElement): KeyboardEvent {
  const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => { textarea.dispatchEvent(event); });
  return event;
}

function mountSending() {
  const sent: string[] = [];
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const view = mountTree(
    <ChatInput onSend={(content) => sent.push(content)} scope={{ type: "manager", threadId: "thr_m" }} />
  );
  return {
    sent,
    container: view.host,
    textarea: view.host.querySelector("textarea")!,
    unmount: () => {
      view.unmount();
      globalThis.getComputedStyle = originalGetComputedStyle;
    }
  };
}

// What Enter does, by the input device the window reports: on a touch screen
// it is left to the textarea, which inserts the line break; with a mouse and
// keyboard it sends, however narrow the window.
const enterRows: Array<{ name: string; media: string | null; sends: boolean }> = [
  { name: "ChatInput: on a touch screen Enter is a new line, not a send", media: "(pointer: coarse)", sends: false },
  { name: "ChatInput: with a mouse and keyboard Enter still sends", media: null, sends: true },
  { name: "ChatInput: a narrow window with a mouse and keyboard still sends on Enter", media: "(max-width: 767px)", sends: true }
];

test.each(enterRows)("$name", async ({ media, sends }) => {
  await withMedia(media, async () => {
    const view = mountSending();
    await typeInto(view.textarea, "hello");
    const enter = pressEnter(view.textarea);
    expect(view.sent).toStrictEqual(sends ? ["hello"] : []);
    expect(enter.defaultPrevented).toBe(sends);
    view.unmount();
  });
});

test("ChatInput: on a touch screen the send button sends and the Enter hint is gone", async () => {
  await withTouchScreen(async () => {
    const view = mountSending();
    await typeInto(view.textarea, "hello");
    expect(view.container.textContent).not.toContain("to send");
    const send = view.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    act(() => { send.click(); });
    expect(view.sent).toStrictEqual(["hello"]);
    view.unmount();
  });
});

// Nothing to send: the send button takes the neutral fill the
// Stop button uses, not the accent at half strength, which read as one
// that can almost be pressed. It has the accent again once there is text.
test("ChatInput: with nothing to send, the send button is neutral; with text, it is the accent", async () => {
  const view = mountSending();
  const send = () => view.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  const classes = () => send().className.split(/\s+/);
  expect(send().disabled).toBe(true);
  expect(classes()).toEqual(expect.arrayContaining(["bg-sel", "text-faint"]));
  expect(classes()).not.toContain("bg-primary");
  expect(classes().some((c) => /opacity-50$/.test(c))).toBe(false);
  await typeInto(view.textarea, "hello");
  expect(send().disabled).toBe(false);
  expect(classes()).toContain("bg-primary");
  expect(classes()).not.toContain("bg-sel");
  view.unmount();
});
