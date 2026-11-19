import { expect, test } from "bun:test";
import { act } from "react";
import { QuestionDock } from "@/routes/window/chat/QuestionDock";
import { useHeldAnswers } from "@/routes/window/chat/useHeldAnswers";
import type { OpenQuestion } from "@shared/questions";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount, typeInto } from "../helpers/mount.js";

const AT = "2026-01-12T14:00:00.000Z";
const PUSH: OpenQuestion = {
  id: "q_1", askedAt: AT, question: "Push fix/evict-order and open a pull request?",
  options: [
    { label: "Push and open the PR", description: "The tests pass and the branch is rebased on main." },
    { label: "Push, no PR yet" },
    { label: "Hold it", description: "Nothing leaves this machine until you say so." }
  ]
};
const TAG: OpenQuestion = { id: "q_2", askedAt: AT, question: "Tag it too?", options: [{ label: "Yes" }, { label: "Not yet" }] };

const slot = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const text = (host: HTMLElement, name: string) => slot(host, name)?.textContent ?? null;
const options = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="question-option"]')];
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); }); };
const field = (host: HTMLElement) => slot(host, "question-input") as HTMLTextAreaElement | null;
/** Held while an answer is on its way: marked, not disabled, so a control that has the focus keeps it. */
const isHeld = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLInputElement).readOnly === true;
const press = async (input: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) => {
  const win = input.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
  await act(async () => { input.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); await Promise.resolve(); });
};
/** A touch screen: matchMedia says the pointer is coarse, and answers every
 *  other query as before. Before mount: the field reads it once. */
const touchScreen = () => {
  const own = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const original = window.matchMedia.bind(window);
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => (query.includes("pointer: coarse")
      ? { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as MediaQueryList
      : original(query))
  });
  onCleanup(() => {
    if (own) Object.defineProperty(window, "matchMedia", own);
    else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });
};

type Send = (q: OpenQuestion, label: string) => Promise<string | null>;
type Skip = (q: OpenQuestion) => Promise<string | null>;
/** The dock as a conversation draws it: the conversation holds the answers,
 *  their drafts and refusals, and may mount the dock anew (`docked` false then true). */
let leftForComposer = 0;
function Docked({ questions, send, skip, docked = true, working = false }: { questions: OpenQuestion[]; send: Send; skip?: Skip; docked?: boolean; working?: boolean }) {
  const answers = useHeldAnswers(send, questions, skip);
  return docked && questions.length > 0 ? <QuestionDock questions={questions} answers={answers} working={working} onLeave={() => { leftForComposer += 1; }} /> : null;
}
function render(questions: OpenQuestion[], send: Send = async () => null) {
  const view = mount(<Docked questions={questions} send={send} />);
  return {
    ...view,
    show: (next: OpenQuestion[]) => view.rerender(<Docked questions={next} send={send} />),
    remount: () => { view.rerender(<Docked questions={questions} send={send} docked={false} />); view.rerender(<Docked questions={questions} send={send} />); }
  };
}

// An answer can need more than a line: Shift+Enter starts one, as in the
// composer, and the answer goes with its lines.
test("the answer field takes more than one line: Shift+Enter is a new line, Enter sends the answer whole", async () => {
  const sent: string[] = [];
  const { host } = render([PUSH], async (_q, label) => { sent.push(label); return null; });
  expect(field(host)!.tagName).toBe("TEXTAREA");
  await typeInto(field(host)!, "Not project-2.\nWe still manage it.");
  await press(field(host)!, "Enter", { shiftKey: true });
  expect(sent).toStrictEqual([]);
  await press(field(host)!, "Enter");
  expect(sent).toStrictEqual(["Not project-2.\nWe still manage it."]);
});

// On a phone Enter is the keyboard's new line, as in the composer: Send sends.
test("on a touch screen Enter is a new line in the answer; Send sends it", async () => {
  touchScreen();
  const sent: string[] = [];
  const { host } = render([PUSH], async (_q, label) => { sent.push(label); return null; });
  await typeInto(field(host)!, "Not project-2.");
  await press(field(host)!, "Enter");
  expect(sent).toStrictEqual([]);
  await click(slot(host, "question-send"));
  expect(sent).toStrictEqual(["Not project-2."]);
});

test("an open question stands with its suggested answers: the first is the recommended one, a description sits under its label", () => {
  const { host } = render([PUSH]);
  expect(text(host, "question-heading")).toBe("Needs your answer");
  expect(text(host, "question-text")).toBe("Push fix/evict-order and open a pull request?");
  expect(options(host).map((o) => o.querySelector('[data-slot="question-option-label"]')!.textContent)).toEqual(["Push and open the PR", "Push, no PR yet", "Hold it"]);
  expect(options(host).map((o) => o.textContent!.includes("Recommended"))).toEqual([true, false, false]);
  expect(options(host).map((o) => o.querySelector('[data-slot="question-option-description"]')?.textContent ?? null))
    .toEqual(["The tests pass and the branch is rebased on main.", null, "Nothing leaves this machine until you say so."]);
  // Anything else is typed in the question itself, not the composer below.
  expect(field(host)!.placeholder).toBe("Type your own answer");
  // One question: nothing to page through.
  expect(slot(host, "question-pager") === null).toBe(true);
});

test("to a screen reader the question is a region named by its heading and described by the question", () => {
  const { host } = render([PUSH]);
  const dock = slot(host, "question-dock")!;
  expect(dock.getAttribute("role")).toBe("region");
  expect(document.getElementById(dock.getAttribute("aria-labelledby")!)!.textContent).toBe("Needs your answer");
  expect(document.getElementById(dock.getAttribute("aria-describedby")!)!.textContent).toBe(PUSH.question);
});

test("a question with no suggested answers asks for a typed one, in the question", () => {
  const { host } = render([{ ...PUSH, options: [] }]);
  expect(options(host).length).toBe(0);
  expect(field(host)!.placeholder).toBe("Type your answer");
});

test("what is typed in the question stays through folding it: a draft, and words whose send is refused while it is folded", async () => {
  let settle!: (reason: string | null) => void;
  const { host } = render([PUSH], () => new Promise((resolve) => { settle = resolve; }));
  const fold = () => click(host.querySelector('[aria-label="Hide the question"]'));
  const unfold = () => click(slot(host, "question-reminder"));
  typeInto(field(host)!, "Push it later today.");
  await fold();
  await unfold();
  expect(field(host)!.value).toBe("Push it later today.");
  await press(field(host)!, "Enter");
  await fold();
  await act(async () => { settle("That question is no longer open."); await Promise.resolve(); });
  await unfold();
  expect(text(host, "question-error")).toBe("That question is no longer open.");
  expect(field(host)!.value).toBe("Push it later today.");
});

test("what is typed in the question, and a refusal, outlive the dock mounted anew (it moves when voice takes the composer's place)", async () => {
  let settle!: (reason: string | null) => void;
  const { host, remount } = render([PUSH], () => new Promise((resolve) => { settle = resolve; }));
  typeInto(field(host)!, "Push it later today.");
  remount();
  expect(field(host)!.value).toBe("Push it later today.");
  await press(field(host)!, "Enter");
  remount();
  await act(async () => { settle("That question is no longer open."); await Promise.resolve(); });
  expect(text(host, "question-error")).toBe("That question is no longer open.");
  expect(field(host)!.value).toBe("Push it later today.");
});

test("a control that has the focus keeps it while its answer is on its way", async () => {
  const { host } = render([PUSH], () => new Promise(() => {}));
  options(host)[1]!.focus();
  await click(options(host)[1]);
  expect(document.activeElement === options(host)[1]!).toBe(true);
  expect(options(host).map(isHeld)).toEqual([true, true, true]);
  // Held, a click sends nothing more.
  runCleanups();
  const sent: string[] = [];
  const typed = render([TAG], (_q, words) => { sent.push(words); return new Promise(() => {}); });
  field(typed.host)!.focus();
  typeInto(field(typed.host)!, "Next week.");
  await press(field(typed.host)!, "Enter");
  expect(document.activeElement === field(typed.host)!).toBe(true);
  expect(isHeld(field(typed.host)!)).toBe(true);
  await click(options(typed.host)[0]);
  expect(sent).toStrictEqual(["Next week."]);
});

test("folding hands the focus to the line that opens it, and opening hands it back", async () => {
  const { host } = render([PUSH]);
  const hide = () => host.querySelector<HTMLElement>('[aria-label="Hide the question"]')!;
  hide().focus();
  await click(hide());
  expect(document.activeElement === slot(host, "question-reminder")).toBe(true);
  await click(slot(host, "question-reminder"));
  expect(document.activeElement === hide()).toBe(true);
});

test("paging keeps the focus on the pager", async () => {
  const { host } = render([PUSH, TAG, { ...TAG, id: "q_3", question: "Announce it?" }]);
  const next = () => host.querySelector<HTMLElement>('[aria-label="Next question"]')!;
  next().focus();
  await click(next());
  expect(text(host, "question-text")).toBe("Tag it too?");
  expect(document.activeElement === next()).toBe(true);
  // At the end Next can go no further: the focus goes back the other way.
  await click(next());
  expect(document.activeElement === host.querySelector('[aria-label="Previous question"]')).toBe(true);
});

test("an answer given from the question moves the focus to the next one, or to the composer when none is left", async () => {
  leftForComposer = 0;
  const { host, show } = render([PUSH, TAG], async () => null);
  field(host)!.focus();
  typeInto(field(host)!, "Push it.");
  await press(field(host)!, "Enter");
  show([TAG]);
  expect(text(host, "question-text")).toBe("Tag it too?");
  expect(document.activeElement === options(host)[0]!).toBe(true);
  await click(options(host)[0]);
  show([]);
  expect(leftForComposer).toBe(1);
  // Answered with the focus elsewhere, nothing is moved.
  const other = render([PUSH], async () => null);
  await click(options(other.host)[0]);
  (document.activeElement as HTMLElement | null)?.blur();
  other.show([]);
  expect(leftForComposer).toBe(1);
});

test("the question can go before its answer is taken: the focus moves on all the same", async () => {
  leftForComposer = 0;
  // The server says the question is answered before it answers the send.
  const { host, show } = render([PUSH, TAG], () => new Promise(() => {}));
  field(host)!.focus();
  typeInto(field(host)!, "Push it.");
  await press(field(host)!, "Enter");
  show([TAG]);
  expect(document.activeElement === options(host)[0]!).toBe(true);
});

// After the answer is sent the focus moves away from the block; when the
// question then goes, nothing takes it back.
const awayRows: Array<{
  name: string;
  /** How the focus leaves the block, `outside` being an input beside it. */
  move: (host: HTMLElement, outside: HTMLInputElement) => void;
  /** Where the focus is once the next question shows. */
  focused: "body" | "outside";
}> = [
  {
    name: "the focus moved away after answering is left where it went: nothing is taken back to the block",
    // The user goes on in the composer while the question is still listed,
    // and then clicks somewhere that takes no focus.
    move: (_host, outside) => {
      act(() => { outside.focus(); });
      act(() => { outside.blur(); });
    },
    focused: "body"
  },
  {
    name: "the focus gone where the page cannot follow (into a canvas's frame) is not taken back either",
    // Into a frame the page hears nothing of where the focus landed.
    move: (_host, outside) => {
      outside.addEventListener("focusin", (e) => e.stopPropagation());
      act(() => { outside.focus(); });
    },
    focused: "outside"
  },
  {
    name: "the focus that left to nothing and then went on outside is not taken back",
    // A click on the transcript's text, then the composer, then the transcript again.
    move: (host, outside) => {
      act(() => { field(host)!.blur(); });
      act(() => { outside.focus(); });
      act(() => { outside.blur(); });
    },
    focused: "body"
  }
];

test.each(awayRows)("$name", async ({ move, focused }) => {
  leftForComposer = 0;
  const outside = document.createElement("input");
  document.body.append(outside);
  try {
    const { host, show } = render([PUSH, TAG], async () => null);
    field(host)!.focus();
    typeInto(field(host)!, "Push it.");
    await press(field(host)!, "Enter");
    move(host, outside);
    show([TAG]);
    expect(document.activeElement === (focused === "body" ? document.body : outside)).toBe(true);
    show([]);
    expect(leftForComposer).toBe(0);
  } finally { outside.remove(); }
});

test("the folded line taking the focus counts: the last question going hands it to the composer", async () => {
  leftForComposer = 0;
  const { host, show } = render([PUSH]);
  await click(host.querySelector('[aria-label="Hide the question"]'));
  slot(host, "question-reminder")!.focus();
  show([]);
  expect(leftForComposer).toBe(1);
});

test("folded after answering, the last question going still hands the focus to the composer", async () => {
  leftForComposer = 0;
  const { host, show } = render([PUSH], async () => null);
  field(host)!.focus();
  typeInto(field(host)!, "Push it.");
  await press(field(host)!, "Enter");
  const hide = host.querySelector<HTMLElement>('[aria-label="Hide the question"]')!;
  hide.focus();
  await click(hide);
  expect(document.activeElement === slot(host, "question-reminder")).toBe(true);
  show([]);
  expect(leftForComposer).toBe(1);
});

test("Enter that confirms an IME candidate is the IME's: nothing is sent until the words are done", async () => {
  const sent: string[] = [];
  const { host } = render([PUSH], async (_q, words) => { sent.push(words); return null; });
  const input = field(host)!;
  typeInto(input, "订单发给bak");
  const win = input.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent; CompositionEvent: typeof CompositionEvent };
  const key = async (init: KeyboardEventInit & { keyCode?: number }) => {
    const event = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    await act(async () => { input.dispatchEvent(event); await Promise.resolve(); });
  };
  await key({ isComposing: true });
  // Safari: the confirming Enter says it is not composing, but its key code does.
  await key({ keyCode: 229 });
  // Between compositionstart and compositionend, whatever the event says.
  await act(async () => { input.dispatchEvent(new win.CompositionEvent("compositionstart", { bubbles: true })); });
  await key({});
  expect(sent).toStrictEqual([]);
  expect(input.value).toBe("订单发给bak");
  await act(async () => { input.dispatchEvent(new win.CompositionEvent("compositionend", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
  typeInto(input, "订单发给 bakery");
  await key({});
  expect(sent).toStrictEqual(["订单发给 bakery"]);
});

test("an answer typed in the question is sent as its answer, once; held until settled, and a refusal keeps the words and says why", async () => {
  const sent: Array<[string, string]> = [];
  let settle!: (reason: string | null) => void;
  const { host } = render([PUSH, TAG], (q, words) => { sent.push([q.id, words]); return new Promise((resolve) => { settle = resolve; }); });
  const send = () => host.querySelector<HTMLButtonElement>('[data-slot="question-send"]')!;
  // Nothing typed, nothing to send.
  expect(isHeld(send())).toBe(true);
  typeInto(field(host)!, "  Push it, but leave group.go alone.  ");
  await press(field(host)!, "Enter");
  expect(sent).toStrictEqual([["q_1", "Push it, but leave group.go alone."]]);
  // Held like a pick: the field, Send and the answers wait for it.
  expect(field(host)!.readOnly).toBe(true);
  expect(options(host).map(isHeld)).toEqual([true, true, true]);
  await click(send());
  expect(sent.length).toBe(1);
  await act(async () => { settle("That question is no longer open."); await Promise.resolve(); });
  expect(text(host, "question-error")).toBe("That question is no longer open.");
  // Refused: the words stay to send again.
  expect(field(host)!.value).toBe("  Push it, but leave group.go alone.  ");
  expect(field(host)!.readOnly).toBe(false);
  await click(send());
  expect(sent.at(-1)).toEqual(["q_1", "Push it, but leave group.go alone."]);
  await act(async () => { settle(null); await Promise.resolve(); });
  // Gone: the field is clear, the question held until the conversation drops it.
  expect(field(host)!.value).toBe("");
  // The next question starts with an empty field of its own, and a draft left
  // there does not follow back.
  await click(host.querySelector('[aria-label="Next question"]'));
  expect(text(host, "question-text")).toBe("Tag it too?");
  expect(field(host)!.value).toBe("");
  expect(field(host)!.readOnly).toBe(false);
  typeInto(field(host)!, "Not yet");
  await click(host.querySelector('[aria-label="Previous question"]'));
  expect(field(host)!.value).toBe("");
});

test("picking an answer sends it once; the answers are held until it is settled, and a refusal is said and lets go", async () => {
  const picked: Array<[string, string]> = [];
  let settle!: (reason: string | null) => void;
  const { host } = render([PUSH], (q, label) => { picked.push([q.id, label]); return new Promise((resolve) => { settle = resolve; }); });
  await click(options(host)[1]);
  expect(picked).toStrictEqual([["q_1", "Push, no PR yet"]]);
  expect(options(host).map(isHeld)).toEqual([true, true, true]);
  // The question's own field waits for the pick too.
  expect(field(host)!.readOnly).toBe(true);
  // Held, so a second click while the first is on its way sends nothing.
  await click(options(host)[0]);
  expect(picked.length).toBe(1);
  await act(async () => { settle("That question is no longer open."); await Promise.resolve(); });
  expect(text(host, "question-error")).toBe("That question is no longer open.");
  expect(slot(host, "question-error")!.getAttribute("role")).toBe("alert");
  expect(options(host).map(isHeld)).toEqual([false, false, false]);
  // Picking again clears what was said.
  await click(options(host)[0]);
  expect(slot(host, "question-error") === null).toBe(true);
  expect(picked.at(-1)).toEqual(["q_1", "Push and open the PR"]);
});

test("a pick that went keeps its answers held until the question leaves; the others stay open to answer", async () => {
  const { host } = render([PUSH, TAG], async () => null);
  await click(options(host)[0]);
  // Sent: the question is still listed until the conversation says it is answered.
  expect(options(host).map(isHeld)).toEqual([true, true, true]);
  expect(slot(host, "question-error") === null).toBe(true);
  await click(host.querySelector('[aria-label="Next question"]'));
  expect(options(host).map(isHeld)).toEqual([false, false]);
  // Answering the second does not let go of the first.
  await click(options(host)[1]);
  await click(host.querySelector('[aria-label="Previous question"]'));
  expect(options(host).map(isHeld)).toEqual([true, true, true]);
});

test("a question that comes back after its pick was taken in can be answered again", async () => {
  // Picked while the asker was busy: the message waited, the question left the list.
  const { host, show } = render([PUSH, TAG], async () => null);
  await click(options(host)[0]);
  show([TAG]);
  // The user took the waiting message back (or the server restarted with it unread): the question is open again.
  show([PUSH, TAG]);
  expect(text(host, "question-text")).toBe(PUSH.question);
  expect(options(host).map(isHeld)).toEqual([false, false, false]);
  await click(options(host)[2]);
  expect(options(host).map(isHeld)).toEqual([true, true, true]);
});

test("several questions are shown one at a time, with where it is among them; an answered one makes room for the next", async () => {
  const { host, show } = render([PUSH, TAG]);
  const pager = () => slot(host, "question-pager")!;
  const [prev, next] = [() => pager().querySelector<HTMLButtonElement>('[aria-label="Previous question"]')!, () => pager().querySelector<HTMLButtonElement>('[aria-label="Next question"]')!];
  expect(text(host, "question-position")).toBe("1 of 2");
  expect(text(host, "question-text")).toBe(PUSH.question);
  expect([prev().disabled, next().disabled]).toEqual([true, false]);
  await click(next());
  expect(text(host, "question-position")).toBe("2 of 2");
  expect(text(host, "question-text")).toBe("Tag it too?");
  expect([prev().disabled, next().disabled]).toEqual([false, true]);
  // The one in view stays in view while another is answered around it.
  show([TAG]);
  expect(text(host, "question-text")).toBe("Tag it too?");
  expect(slot(host, "question-pager") === null).toBe(true);
  // The one in view answered: the first of what is left, not the nearest or the last.
  const NOTES: OpenQuestion = { id: "q_3", askedAt: AT, question: "Write the release notes?", options: [] };
  show([PUSH, TAG, NOTES]);
  expect(text(host, "question-position")).toBe("2 of 3");
  show([PUSH, NOTES]);
  expect([text(host, "question-position"), text(host, "question-text")]).toEqual(["1 of 2", PUSH.question]);
});

test("it folds to one line that says how many wait, and opens again", async () => {
  const { host, show } = render([PUSH, TAG]);
  await click(host.querySelector('[aria-label="Hide the question"]'));
  expect(slot(host, "question-dock") === null).toBe(true);
  const line = slot(host, "question-reminder")!;
  expect(line.textContent).toBe(`2 questions${PUSH.question}`);
  expect(line.getAttribute("aria-expanded")).toBe("false");
  show([TAG]);
  expect(slot(host, "question-reminder")!.textContent).toBe("1 questionTag it too?");
  await click(slot(host, "question-reminder"));
  expect(text(host, "question-text")).toBe("Tag it too?");
  expect(slot(host, "question-reminder") === null).toBe(true);
});

test("a question can be skipped from the end of its head; held while the skip is on its way, and told why if it is refused", async () => {
  let settle!: (reason: string | null) => void;
  const skipped: string[] = [];
  const { host } = mount(<Docked questions={[PUSH, TAG]} send={async () => null} skip={(q) => { skipped.push(q.id); return new Promise((resolve) => { settle = resolve; }); }} />);
  const skip = slot(host, "question-skip") as HTMLButtonElement;
  expect([skip.textContent, skip.title]).toEqual(["Skip", "Skip without answering"]);
  // The last thing on the head's line, after paging and folding.
  expect(skip.parentElement!.lastElementChild === skip).toBe(true);
  expect(skip.previousElementSibling!.getAttribute("aria-label")).toBe("Hide the question");
  await click(skip);
  expect(skipped).toStrictEqual(["q_1"]);
  expect(options(host).every(isHeld)).toBe(true);
  expect(isHeld(skip)).toBe(true);
  await act(async () => { settle("That question is no longer open."); await Promise.resolve(); });
  expect(text(host, "question-error")).toBe("That question is no longer open.");
  expect(options(host).some(isHeld)).toBe(false);
});

// ---- A long question opens in full from the top right ----

const LONG: OpenQuestion = {
  id: "q_long", askedAt: AT,
  question: Array.from({ length: 12 }, (_, i) => `Point ${i + 1}: the order form keeps multipart fields as written, and n=+1 reaches the bakery unchanged.`).join("\n\n"),
  options: [{ label: "Fix it" }, { label: "Hold it" }]
};

/** happy-dom does no layout: the question's text is taller than its box when
 *  it is long and still clipped, as a browser would measure it. */
function measureQuestions() {
  const proto = HTMLElement.prototype;
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const client = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  const textOf = (el: HTMLElement) => el.getAttribute("data-slot") === "question-text";
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) { return textOf(this) ? (this.textContent!.length > 400 ? 900 : 60) : 0; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) { return textOf(this) ? (this.getAttribute("data-expanded") === "true" ? (this.textContent!.length > 400 ? 900 : 60) : 144) : 0; } });
  return () => {
    if (scroll) Object.defineProperty(proto, "scrollHeight", scroll); else delete (proto as { scrollHeight?: number }).scrollHeight;
    if (client) Object.defineProperty(proto, "clientHeight", client); else delete (proto as { clientHeight?: number }).clientHeight;
  };
}

test("a long question offers Show all at the top right, beside the fold; open, it is all there, and Show less puts it back", async () => {
  const restore = measureQuestions();
  try {
    const { host } = render([LONG, TAG]);
    const expand = () => host.querySelector<HTMLButtonElement>('button[aria-label="Show all"], button[aria-label="Show less"]');
    // In the head's row, before the fold.
    const fold = host.querySelector('[aria-label="Hide the question"]')!;
    expect(expand()!.closest('[data-slot="question-head"]') !== null && fold.closest('[data-slot="question-head"]') === expand()!.closest('[data-slot="question-head"]')).toBe(true);
    expect(expand()!.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([expand()!.getAttribute("aria-label"), expand()!.getAttribute("aria-expanded"), slot(host, "question-text")!.getAttribute("data-expanded")]).toEqual(["Show all", "false", "false"]);
    expect(slot(host, "question-text")!.getAttribute("data-cut")).toBe("true");
    await click(expand());
    expect([expand()!.getAttribute("aria-label"), expand()!.getAttribute("aria-expanded"), slot(host, "question-text")!.getAttribute("data-expanded")]).toEqual(["Show less", "true", "true"]);
    expect(slot(host, "question-text")!.getAttribute("data-cut")).toBe("false");
    await click(expand());
    expect(slot(host, "question-text")!.getAttribute("data-expanded")).toBe("false");
    // Open again, then on to the next question: that one starts as it stands, and it is short: no button.
    await click(expand());
    await click(host.querySelector('[aria-label="Next question"]'));
    expect(text(host, "question-text")).toBe("Tag it too?");
    expect(expand() === null).toBe(true);
    // Back: the long one starts clipped again.
    await click(host.querySelector('[aria-label="Previous question"]'));
    expect(expand()!.getAttribute("aria-label")).toBe("Show all");
  } finally { restore(); }
});

test("a short question has no Show all", () => {
  const restore = measureQuestions();
  try {
    const { host } = render([PUSH]);
    expect(host.querySelector('button[aria-label="Show all"]') === null).toBe(true);
    expect(slot(host, "question-text")!.getAttribute("data-cut")).toBe("false");
  } finally { restore(); }
});

test("read to its end, opened and put back, the question fades at its cut again (it starts from its top)", async () => {
  const restore = measureQuestions();
  try {
    const { host } = render([LONG]);
    const textEl = slot(host, "question-text")!;
    act(() => {
      textEl.scrollTop = 756;
      const win = textEl.ownerDocument.defaultView as unknown as { Event: typeof Event };
      textEl.dispatchEvent(new win.Event("scroll"));
    });
    expect(textEl.getAttribute("data-cut")).toBe("false");
    await click(host.querySelector('button[aria-label="Show all"]'));
    await click(host.querySelector('button[aria-label="Show less"]'));
    expect(slot(host, "question-text")!.getAttribute("data-cut")).toBe("true");
  } finally { restore(); }
});

// While the agent still works, a question waits as its folded line: the
// reply that explains it comes first, and the line opens it for an early
// answer. When the agent stops, the question opens. What the reader did with
// it stands.
test("while the agent works the question shows as its folded line, and opens when it stops", () => {
  const send: Send = async () => null;
  const view = mount(<Docked questions={[PUSH]} send={send} working />);
  expect(text(view.host, "question-reminder")).toContain("1 question");
  expect(options(view.host).length).toBe(0);
  view.rerender(<Docked questions={[PUSH]} send={send} working={false} />);
  expect(slot(view.host, "question-reminder") === null).toBe(true);
  expect(options(view.host).length).toBe(3);
});

test("opened while the agent works it stays open when it stops; folded at rest it stays folded through the next turn", async () => {
  const send: Send = async () => null;
  const view = mount(<Docked questions={[PUSH]} send={send} working />);
  await click(slot(view.host, "question-reminder"));
  expect(options(view.host).length).toBe(3);
  view.rerender(<Docked questions={[PUSH]} send={send} working={false} />);
  expect(options(view.host).length).toBe(3);
  await click(view.host.querySelector('[aria-label="Hide the question"]'));
  view.rerender(<Docked questions={[PUSH]} send={send} working />);
  view.rerender(<Docked questions={[PUSH]} send={send} working={false} />);
  expect(slot(view.host, "question-reminder") !== null).toBe(true);
});

test("folding and opening on their own move no focus", () => {
  const send: Send = async () => null;
  const outside = document.createElement("button");
  document.body.append(outside);
  onCleanup(() => outside.remove());
  const view = mount(<Docked questions={[PUSH]} send={send} working />);
  outside.focus();
  view.rerender(<Docked questions={[PUSH]} send={send} working={false} />);
  expect(document.activeElement === outside).toBe(true);
  view.rerender(<Docked questions={[PUSH]} send={send} working />);
  expect(document.activeElement === outside).toBe(true);
});

// The keyboard keeps its place through what the dock does on its own: a
// reader in the question when a turn starts keeps it open, and the folded
// line that has the focus hands it on as the question opens.
test("a turn that starts while the reader is in the question leaves it open, the focus where it was", async () => {
  const send: Send = async () => null;
  const view = mount(<Docked questions={[PUSH]} send={send} />);
  await act(async () => { field(view.host)!.focus(); await Promise.resolve(); });
  view.rerender(<Docked questions={[PUSH]} send={send} working />);
  expect(options(view.host).length).toBe(3);
  expect(document.activeElement === field(view.host)).toBe(true);
});

test("the folded line that has the focus hands it to the question as it opens when the agent stops", async () => {
  const send: Send = async () => null;
  const view = mount(<Docked questions={[PUSH]} send={send} working />);
  await act(async () => { slot(view.host, "question-reminder")!.focus(); await Promise.resolve(); });
  view.rerender(<Docked questions={[PUSH]} send={send} working={false} />);
  await act(async () => { await Promise.resolve(); });
  expect(options(view.host).length).toBe(3);
  expect(view.host.contains(document.activeElement)).toBe(true);
});

// Left for the transcript's text (no control takes the focus), the dock is
// no longer the reader's: what it does on its own pulls no focus back.
test("a reader who left the question for the transcript's text is not pulled back when it opens or folds on its own", async () => {
  const send: Send = async () => null;
  const view = mount(<Docked questions={[PUSH]} send={send} working />);
  await act(async () => { slot(view.host, "question-reminder")!.focus(); await Promise.resolve(); });
  await act(async () => { (document.activeElement as HTMLElement).blur(); await Promise.resolve(); });
  view.rerender(<Docked questions={[PUSH]} send={send} working={false} />);
  await act(async () => { await Promise.resolve(); });
  expect(options(view.host).length).toBe(3);
  expect(view.host.contains(document.activeElement)).toBe(false);
  await act(async () => { field(view.host)!.focus(); await Promise.resolve(); });
  await act(async () => { (document.activeElement as HTMLElement).blur(); await Promise.resolve(); });
  view.rerender(<Docked questions={[PUSH]} send={send} working />);
  await act(async () => { await Promise.resolve(); });
  expect(slot(view.host, "question-reminder") !== null).toBe(true);
  expect(view.host.contains(document.activeElement)).toBe(false);
});
