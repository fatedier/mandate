import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatInput } from "../src/client/routes/window/chat/ChatInput.js";
import type { AgentCommandDto, AgentCommandState } from "../src/shared/api/agents.js";
import { onCleanup, runCleanups } from "./helpers/cleanup.js";
import { mountAsync } from "./helpers/mount.js";
import { fireAnimation, slotAnimating } from "./helpers/motion.js";

const COMMANDS: AgentCommandDto[] = [
  { name: "/compact", description: "Summarize earlier messages to free up context", blocked: { running: "A turn is running", compacting: "Already compacting" } },
  { name: "/stop", description: "Stop the running turn", blocked: { idle: "Nothing is running", compacting: "A compaction can't be stopped" } },
  { name: "/context", description: "Show how much context is in use", blocked: {} }
];

afterEach(() => runCleanups());

type Scope = { type: "worker"; featureId: string };

async function composer(opts: { commands?: AgentCommandDto[] | null; state?: AgentCommandState; taken?: boolean | Promise<boolean>; scope?: Scope } = {}) {
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const sent: string[] = [];
  const commanded: Array<[string, number]> = [];
  let inputs = 0;
  const node = (scope: Scope | undefined) => (
    <ChatInput
      scope={scope}
      onSend={(content) => { sent.push(content); }}
      commands={opts.commands === null ? undefined : opts.commands ?? COMMANDS}
      commandState={opts.state ?? "idle"}
      onCommand={async (text, attachments) => { commanded.push([text, attachments]); return opts.taken ?? true; }}
      onDraftInput={() => { inputs += 1; }}
    />
  );
  const { host, unmount, rerender } = await mountAsync(node(opts.scope));
  /** The same composer, shown for another conversation. */
  const show = (scope: Scope) => rerender(node(scope));
  const textarea = host.getElementsByTagName("textarea")[0]!;
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    });
  };
  const key = async (name: string, init: KeyboardEventInit = {}) => {
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="command-list"] [role="option"]')];
  const list = () => rows().map((row) => `${row.children[0]!.textContent}${row.getAttribute("aria-selected") === "true" ? "*" : ""}`);
  return { textarea, type, key, rows, list, sent, commanded, inputs: () => inputs, unmount, show };
}

test("a slash opens the list of commands; arrows move through it and wrap", async () => {
  const c = await composer();
  expect(c.list()).toEqual([]);
  await c.type("/");
  expect(c.list()).toEqual(["/compact*", "/stop", "/context"]);
  await c.key("ArrowDown");
  expect(c.list()).toEqual(["/compact", "/stop*", "/context"]);
  await c.key("ArrowUp");
  await c.key("ArrowUp");
  expect(c.list()).toEqual(["/compact", "/stop", "/context*"]);
  // The row a reader of the screen is on is the textarea's active descendant.
  expect(c.textarea.getAttribute("aria-activedescendant")).toBe(c.rows()[2]!.id);
  await c.type("/c");
  expect(c.list()).toEqual(["/compact*", "/context"]);
  // A path, or a draft that is past its first word, opens nothing.
  for (const draft of ["/tmp/foo", "/compact now", "hello"]) { await c.type(draft); expect(c.list()).toEqual([]); }
});

test("Enter on a part of a command completes it and runs nothing; Enter on the whole name runs it", async () => {
  const c = await composer();
  await c.type("/c");
  await c.key("Enter");
  expect([c.textarea.value, c.list(), c.commanded, c.sent]).toEqual(["/compact", [], [], []]);
  await c.key("Enter");
  expect(c.commanded).toStrictEqual([["/compact", 0]]);
  expect(c.sent).toStrictEqual([]);
  // Taken: the draft is gone.
  expect(c.textarea.value).toBe("");
});

test("a name typed whole runs at Enter, with the list still open on it", async () => {
  const c = await composer();
  await c.type("/stop");
  expect(c.list()).toEqual(["/stop*"]);
  await c.key("Enter");
  expect([c.commanded, c.sent]).toEqual([[["/stop", 0]], []]);
});

test("a second Enter while a command is on its way runs nothing more", async () => {
  let answer!: (taken: boolean) => void;
  const c = await composer({ taken: new Promise<boolean>((resolve) => { answer = resolve; }) });
  await c.type("/context");
  await c.key("Enter");
  await c.key("Enter");
  expect([c.commanded, c.textarea.value]).toEqual([[["/context", 0]], "/context"]);
  await act(async () => { answer(true); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(c.textarea.value).toBe("");
  // Answered: the next one runs.
  await c.type("/context");
  await c.key("Enter");
  expect(c.commanded.length).toBe(2);
});

test("what is typed while a command is on its way is kept when the command is taken", async () => {
  let answer!: (taken: boolean) => void;
  const c = await composer({ taken: new Promise<boolean>((resolve) => { answer = resolve; }) });
  await c.type("/context");
  await c.key("Enter");
  await c.type("the next thing");
  await act(async () => { answer(true); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(c.textarea.value).toBe("the next thing");
});

test("nothing else is sent while a command is on its way: one thing at a time", async () => {
  let answer!: (taken: boolean) => void;
  const c = await composer({ taken: new Promise<boolean>((resolve) => { answer = resolve; }) });
  await c.type("/context");
  await c.key("Enter");
  await c.type("hello");
  await c.key("Enter");
  expect([c.commanded, c.sent, c.textarea.value]).toEqual([[["/context", 0]], [], "hello"]);
  await act(async () => { answer(false); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await c.key("Enter");
  expect(c.sent).toStrictEqual(["hello"]);
});

test("an Esc the IME takes leaves the list open", async () => {
  const c = await composer();
  await c.type("/c");
  await act(async () => { c.textarea.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); });
  // Safari sends the Esc that cancels a candidate as an ordinary Escape.
  await c.key("Escape", { isComposing: true });
  expect(c.list()).toEqual(["/compact*", "/context"]);
  await act(async () => {
    c.textarea.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await c.key("Escape");
  expect(c.list()).toEqual([]);
});

test("Tab and a click fill a command in without running it; Esc closes the list and leaves the text", async () => {
  const c = await composer();
  await c.type("/co");
  await c.key("Tab");
  expect([c.textarea.value, c.list(), c.commanded]).toEqual(["/compact", [], []]);
  // A name already whole has nothing left to fill in: Tab puts the list away.
  await c.type("/stop");
  await c.key("Tab");
  expect([c.textarea.value, c.list(), c.commanded]).toEqual(["/stop", [], []]);

  await c.type("/");
  await act(async () => { c.rows()[2]!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
  expect([c.textarea.value, c.list(), c.commanded]).toEqual(["/context", [], []]);

  await c.type("/");
  await c.key("Escape");
  expect([c.textarea.value, c.list()]).toEqual(["/", []]);
  // It stays closed for that text, and comes back when the text changes.
  await c.type("/s");
  expect(c.list()).toEqual(["/stop*"]);
  // Esc closes it from anywhere on the page, not only from the textarea.
  await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(c.list()).toEqual([]);
});

test("a list that closes fades out as it was, out of the pointer's way, then is gone", async () => {
  const c = await composer();
  slotAnimating("command-list", (el) => (el.getAttribute("data-state") === "closed" ? "exit" : "enter"));
  await c.type("/");
  expect(c.list()).toEqual(["/compact*", "/stop", "/context"]);
  await c.key("Escape");
  const leaving = document.querySelector<HTMLElement>('[data-slot="command-list"]')!;
  // Out of the pointer's way, over Radix's own inline pointer-events in a modal sheet.
  expect([c.list(), leaving.getAttribute("data-state"), leaving.className.split(/\s+/).includes("data-[state=closed]:pointer-events-none!")])
    .toEqual([["/compact*", "/stop", "/context"], "closed", true]);
  fireAnimation(leaving, "animationend", "exit");
  await act(async () => {});
  expect(document.querySelector('[data-slot="command-list"]') === null).toBe(true);
});

test("the same text typed over itself opens the list again", async () => {
  const c = await composer();
  await c.type("/");
  await c.key("ArrowDown");
  await c.key("Escape");
  expect(c.list()).toEqual([]);
  // The slash is selected and typed again: the text is what it was, the keystroke
  // is new. The list opens as a first slash opens it, on its first row.
  const before = c.inputs();
  await c.type("/");
  expect([c.list(), c.inputs() - before]).toEqual([["/compact*", "/stop", "/context"], 1]);
});

test("a list that typing opened in one conversation is not open in another, nor on the way back", async () => {
  const a = { type: "worker" as const, featureId: "commands-list-a" };
  const b = { type: "worker" as const, featureId: "commands-list-b" };
  const c = await composer({ scope: b });
  await c.type("/c");
  c.show(a);
  await c.type("/c");
  expect(c.list()).toEqual(["/compact*", "/context"]);
  // The other conversation's draft reads the same; nobody typed it just now.
  c.show(b);
  expect([c.textarea.value, c.list()]).toEqual(["/c", []]);
  c.show(a);
  expect([c.textarea.value, c.list()]).toEqual(["/c", []]);
  await c.type("");
  c.show(b);
  await c.type("");
});

test("a draft the box comes back with opens no list until it is typed in", async () => {
  const scope = { type: "worker" as const, featureId: "commands-restored-draft" };
  const first = await composer({ scope });
  await first.type("/c");
  expect(first.list()).toEqual(["/compact*", "/context"]);
  // The panel hides and comes back: the draft is kept, and nobody is typing.
  first.unmount();
  const second = await composer({ scope });
  expect([second.textarea.value, second.list()]).toEqual(["/c", []]);
  await second.type("/co");
  expect(second.list()).toEqual(["/compact*", "/context"]);
  await second.type("");
});

test("sending a command puts its list away: a refusal's line above the box is not under it", async () => {
  const c = await composer({ taken: false });
  await c.type("/compact");
  expect(c.list()).toEqual(["/compact*"]);
  await c.key("Enter");
  // Refused: the draft stays, and the list does not stay over what the refusal says.
  expect([c.commanded, c.textarea.value, c.list()]).toEqual([[["/compact", 0]], "/compact", []]);
  // The next keystroke brings it back.
  await c.type("/compac");
  expect(c.list()).toEqual(["/compact*"]);
});

test("a refused command keeps its draft; an ordinary draft, a path among them, is sent as a message", async () => {
  const refused = await composer({ taken: false });
  await refused.type("/compact now");
  await refused.key("Enter");
  // The whole draft goes to the server, which says what is wrong with it.
  expect([refused.commanded, refused.sent, refused.textarea.value]).toEqual([[["/compact now", 0]], [], "/compact now"]);

  const plain = await composer();
  await plain.type("/tmp/foo is broken");
  await plain.key("Enter");
  expect([plain.commanded, plain.sent]).toEqual([[], ["/tmp/foo is broken"]]);
});

test("a command that cannot run now stays in the list, greyed, with the reason", async () => {
  const c = await composer({ state: "running" });
  await c.type("/");
  expect(c.rows().map((row) => [row.hasAttribute("data-blocked"), row.textContent])).toEqual([
    [true, "/compactSummarize earlier messages to free up contextA turn is running"],
    [false, "/stopStop the running turn"],
    [false, "/contextShow how much context is in use"]
  ]);
});

test("while an IME candidate is being confirmed, Enter neither completes nor sends", async () => {
  const c = await composer();
  await act(async () => { c.textarea.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true })); });
  await c.type("/c");
  await c.key("Enter");
  expect([c.textarea.value, c.commanded, c.sent]).toEqual(["/c", [], []]);
});

test("a composer given no commands is the composer it was; every keystroke and send is reported", async () => {
  const c = await composer({ commands: null });
  await c.type("/");
  expect(c.list()).toEqual([]);
  await c.key("Enter");
  expect([c.sent, c.commanded]).toEqual([["/"], []]);
  // One for the keystroke, one for the send: what clears a status line above.
  expect(c.inputs()).toBe(2);
});
