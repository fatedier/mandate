import { expect, test } from "bun:test";
import { act, useRef } from "react";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { useAutoFitTextarea } from "@/routes/window/chat/composer-hooks";
import { onCleanup } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

/** The composer's layout as a test sets it (happy-dom lays nothing out): its
 *  content height and width, and its resize observer, captured so a test can
 *  say "it resized". */
function stubLayout() {
  const layout = { content: 44, width: 324, resized: (() => {}) as () => void };
  const proto = window.HTMLTextAreaElement.prototype;
  const savedObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { layout.resized = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => layout.content });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => layout.width });
  onCleanup(() => {
    globalThis.ResizeObserver = savedObserver;
    delete (proto as unknown as Record<string, unknown>).scrollHeight;
    delete (proto as unknown as Record<string, unknown>).offsetWidth;
  });
  return layout;
}

function type(ta: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(ta, text);
    ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("an empty composer is measured again when its width changes, not only when its text does", () => {
  // The global agent's placeholder fits one line, then the box narrows and
  // it wraps to two: measured only on typing, the box stayed one line short
  // and showed a scrollbar for the few pixels over (seen on a phone).
  const layout = stubLayout();
  const { host } = mount(<ChatInput scope={{ type: "global", threadId: "thr_g" }} onSend={() => {}} />);
  const ta = host.querySelector("textarea")!;
  expect(ta.style.height).toBe("44px");
  layout.content = 49;
  layout.width = 294;
  act(() => layout.resized());
  expect(ta.style.height).toBe("49px");
});

test("below its cap the composer shows no scrollbar; past it, it scrolls", () => {
  const layout = stubLayout();
  layout.content = 49;
  const { host } = mount(<ChatInput scope={{ type: "global", threadId: "thr_g" }} onSend={() => {}} />);
  const ta = host.querySelector("textarea")!;
  expect(ta.style.overflowY).toBe("hidden");
  layout.content = 400; // eight lines are the cap
  type(ta, "a long message\n".repeat(20));
  expect(ta.style.overflowY).toBe("auto");
});

function Box({ value }: { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoFitTextarea(ref, value);
  return <div data-slot="holder"><textarea ref={ref} value={value} readOnly /></div>;
}

// The box fits its text by dropping to one line and measuring. The composer
// around it keeps its height meanwhile: its dropping too made the transcript
// above taller for a moment, and the browser pulled the transcript's scroll
// back with it (a reader at the end was taken as having scrolled up).
test("the box measures its text with the composer around it held at its height, and lets go after", () => {
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const { host, rerender } = mount(<Box value="one" />);
  const holder = host.querySelector<HTMLElement>('[data-slot="holder"]')!;
  const box = host.querySelector("textarea")!;
  // The test DOM has no layout: the composer is 80px high, the text 60px.
  const held: string[] = [];
  Object.defineProperty(holder, "offsetHeight", { configurable: true, get: () => 80 });
  Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => { held.push(holder.style.minHeight); return 60; } });
  holder.style.minHeight = "10px";
  rerender(<Box value={"one\ntwo\nthree"} />);
  expect(held.length).toBeGreaterThan(0);
  expect(held.every((value) => value === "80px")).toBe(true);
  expect([box.style.height, holder.style.minHeight]).toEqual(["60px", "10px"]);
});
