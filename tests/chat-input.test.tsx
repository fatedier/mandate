import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatInput } from "../src/client/routes/window/chat/ChatInput.js";
import type { AgentChatScope } from "../src/client/store/agent-chat.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("ChatInput: Enter during IME composition does not send", async () => {
  const sent: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({
    lineHeight: "20px"
  })) as unknown as typeof globalThis.getComputedStyle;

  try {
    await act(async () => {
      root.render(<ChatInput onSend={(content) => sent.push(content)} />);
    });

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
    expect(sent).toEqual([]);

    await act(async () => {
      textarea.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
      textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true
      }));
    });
    expect(sent).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true
      }));
    });
    expect(sent).toEqual(["nihao"]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    globalThis.getComputedStyle = originalGetComputedStyle;
    container.remove();
  }
});

test("ChatInput: busy send and queued tray remain interactive without working copy", async () => {
  const sent: string[] = [];
  const removed: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({
    lineHeight: "20px"
  })) as unknown as typeof globalThis.getComputedStyle;

  try {
    await act(async () => {
      root.render(<ChatInput busyHint onCancel={() => {}} onSend={(content) => sent.push(content)} />);
    });
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
    expect(container.querySelector('button[aria-label="Stop agent"]')).toBeNull();
    await act(async () => {
      sendButton.click();
    });
    expect(sent).toEqual(["guide the next step"]);

    await act(async () => {
      root.render(
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
    });
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
    expect(removed).toEqual(["local-queued"]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    globalThis.getComputedStyle = originalGetComputedStyle;
    container.remove();
  }
});

function mount(props: { scope?: AgentChatScope }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  act(() => {
    root.render(<ChatInput onSend={() => {}} scope={props.scope} />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      globalThis.getComputedStyle = originalGetComputedStyle;
      container.remove();
    }
  };
}

test("ChatInput: the placeholder names the scope", async () => {
  const worker = mount({ scope: { type: "worker", featureId: "f1" } });
  expect(worker.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message the worker…");
  worker.unmount();
  const manager = mount({ scope: { type: "manager" } });
  expect(manager.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message the manager…");
  manager.unmount();
  const side = mount({});
  expect(side.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Message…");
  side.unmount();
});

test("ChatInput: the composer is a raised card with the send hint", async () => {
  const view = mount({ scope: { type: "manager" } });
  const card = view.container.querySelector('[data-slot="composer"]')!;
  expect(card === null).toBe(false);
  expect(card.className.split(/\s+/)).toContain("shadow-composer");
  expect(view.container.textContent).toContain("to send");
  expect(view.container.querySelector("textarea")?.style.maxHeight).toBe("calc(8lh + 0.25rem)");
  view.unmount();
});
