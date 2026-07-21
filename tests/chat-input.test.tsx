import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatInput } from "../src/client/routes/window/chat/ChatInput.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("ChatInput: Enter during IME composition does not send", async () => {
  const sent: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({
    lineHeight: "20px"
  })) as typeof globalThis.getComputedStyle;

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
  })) as typeof globalThis.getComputedStyle;

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
