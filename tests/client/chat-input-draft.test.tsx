import { expect, test } from "bun:test";
import { act } from "react";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { onCleanup } from "../helpers/cleanup.js";
import { mount as mountTree, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;

const w1 = { type: "worker" as const, featureId: "draft-w1" };
const w2 = { type: "worker" as const, featureId: "draft-w2" };

function mount(scope: typeof w1, onSend: (text: string) => void = () => {}) {
  const node = <ChatInput scope={scope} onSend={onSend} />;
  if (view) view.rerender(node);
  else {
    view = mountTree(node);
    // The next test mounts afresh.
    onCleanup(() => { view = null; });
  }
  return view.host.querySelector("textarea")!;
}
function type(ta: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(ta, text);
    ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function unmount() {
  view?.unmount();
  view = null;
}

test("an unsent message outlives its composer: hiding the panel keeps what was typed", () => {
  type(mount(w1), "Rename the flag too");
  // The panel hides: the composer unmounts; it comes back.
  unmount();
  expect(mount(w1).value).toBe("Rename the flag too");
});

test("each conversation keeps its own draft, and sending clears it", () => {
  const sent: string[] = [];
  type(mount(w1, (t) => sent.push(t)), "for w1");
  // The same composer shown for another conversation.
  expect(mount(w2).value).toBe("");
  type(mount(w2), "for w2");
  const ta = mount(w1, (t) => sent.push(t));
  expect(ta.value).toBe("for w1");
  act(() => { view!.host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click(); });
  expect(sent).toStrictEqual(["for w1"]);
  unmount();
  expect(mount(w1).value).toBe("");
  expect(mount(w2).value).toBe("for w2");
  type(mount(w2), "");
});

test("the composer asks for what its conversation is for", () => {
  const placeholderFor = (scope?: Parameters<typeof ChatInput>[0]["scope"]) => {
    const tree = mountTree(<ChatInput scope={scope} onSend={() => {}} />);
    const text = tree.host.querySelector("textarea")!.placeholder;
    tree.unmount();
    return text;
  };
  expect([
    placeholderFor({ type: "worker", featureId: "draft-p" }),
    placeholderFor({ type: "manager", threadId: "thr_p" }),
    placeholderFor({ type: "global", threadId: "thr_g" }),
    placeholderFor(undefined)
  ]).toEqual([
    "Message the worker…",
    "Message the manager…",
    "Ask about any thread or worker, or tell one what to do",
    "Message…"
  ]);
});
