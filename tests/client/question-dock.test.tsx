import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { QuestionDock } from "@/routes/window/chat/QuestionDock";
import { useHeldAnswers } from "@/routes/window/chat/useHeldAnswers";
import type { ShownQuestion } from "@/lib/shown-questions";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

afterEach(() => runCleanups());

const AT = "2026-01-12T14:00:00.000Z";
const PUSH: ShownQuestion = {
  id: "q_1", askedAt: AT, question: "Push fix/evict-order and open a pull request?",
  options: [
    { label: "Push and open the PR", description: "The tests pass and the branch is rebased on main." },
    { label: "Push, no PR yet" },
    { label: "Hold it", description: "Nothing leaves this machine until you say so." }
  ]
};
const TAG: ShownQuestion = { id: "q_2", askedAt: AT, question: "Tag it too?", options: [{ label: "Yes" }, { label: "Not yet" }] };

const slot = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const text = (host: HTMLElement, name: string) => slot(host, name)?.textContent ?? null;
const options = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="question-option"]')];
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); }); };
const field = (host: HTMLElement) => slot(host, "question-input") as HTMLInputElement | null;
/** Held while an answer is on its way: marked, not disabled, so a control that has the focus keeps it. */
const isHeld = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLInputElement).readOnly === true;
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setValue.call(input, value);
    const win = input.ownerDocument.defaultView as unknown as { Event: typeof Event };
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}
const press = async (input: HTMLInputElement, key: string) => {
  const win = input.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
  await act(async () => { input.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true })); await Promise.resolve(); });
};

type Send = (q: ShownQuestion, label: string) => Promise<string | null>;
type Skip = (q: ShownQuestion) => Promise<string | null>;
/** The dock as a conversation draws it: the conversation holds the answers,
 *  their drafts and refusals, and may mount the dock anew (`docked` false then true). */
let leftForComposer = 0;
function Docked({ questions, send, skip, docked = true }: { questions: ShownQuestion[]; send: Send; skip?: Skip; docked?: boolean }) {
  const answers = useHeldAnswers(send, questions, skip);
  return docked && questions.length > 0 ? <QuestionDock questions={questions} answers={answers} onLeave={() => { leftForComposer += 1; }} /> : null;
}
function render(questions: ShownQuestion[], send: Send = async () => null) {
  const view = mount(<Docked questions={questions} send={send} />);
  return {
    ...view,
    show: (next: ShownQuestion[]) => view.rerender(<Docked questions={next} send={send} />),
    remount: () => { view.rerender(<Docked questions={questions} send={send} docked={false} />); view.rerender(<Docked questions={questions} send={send} />); }
  };
}

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
  expect(slot(host, "question-hint") === null).toBe(true);
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
  expect(slot(host, "question-hint") === null).toBe(true);
});

test("a worker's question nobody took up is headed with the worker's name", () => {
  const { host } = render([{ id: "plan:evict:0", askedAt: AT, question: "May I run the full build in a loop?", options: [], from: "upload-probe" }]);
  expect(text(host, "question-heading")).toBe("upload-probe is waiting for an answer");
  expect(text(host, "question-text")).toBe("May I run the full build in a loop?");
  // Not the manager's question: the answer goes to the manager below, who passes it on.
  expect(field(host) === null).toBe(true);
  expect(text(host, "question-hint")).toBe("Type your answer below.");
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

test("an answer that leaves a worker's question in view hands the focus to the composer, where that one is answered", async () => {
  leftForComposer = 0;
  const workers: ShownQuestion = { id: "plan:evict:0", askedAt: AT, question: "May I run the full build in a loop?", options: [], from: "upload-probe" };
  const { host, show } = render([PUSH, workers], async () => null);
  options(host)[0]!.focus();
  await click(options(host)[0]);
  show([workers]);
  expect(text(host, "question-heading")).toBe("upload-probe is waiting for an answer");
  expect(leftForComposer).toBe(1);
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
  typeInto(input, "部署到sta");
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
  expect(input.value).toBe("部署到sta");
  await act(async () => { input.dispatchEvent(new win.CompositionEvent("compositionend", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
  typeInto(input, "部署到 staging");
  await key({});
  expect(sent).toStrictEqual(["部署到 staging"]);
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
  const { host, show } = render([PUSH, TAG], async () => null);
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
  show([]);
  expect(host.textContent).toBe("");
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
  const NOTES: ShownQuestion = { id: "q_3", askedAt: AT, question: "Write the release notes?", options: [] };
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

test("with nothing open there is nothing above the composer", () => {
  const { host } = render([]);
  expect(host.textContent).toBe("");
  expect(host.querySelector("*") === null).toBe(true);
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

test("a worker's question has no Skip: it is the worker's plan that holds it", () => {
  const { host } = mount(<Docked questions={[{ id: "plan:evict:0", askedAt: AT, question: "May I run the full build in a loop?", options: [], from: "upload-probe" }]} send={async () => null} skip={async () => null} />);
  expect(slot(host, "question-skip") === null).toBe(true);
});
