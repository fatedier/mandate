import { afterEach, expect, test } from "bun:test";
import { QuestionAnnouncer } from "@/routes/window/chat/QuestionAnnouncer";
import type { ShownQuestion } from "@/lib/shown-questions";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

afterEach(() => runCleanups());

// A question appearing above the composer is said aloud to a screen reader:
// once, when it is new, with who waits for it.

const AT = "2026-01-12T14:00:00.000Z";
const PUSH: ShownQuestion = { id: "q_1", askedAt: AT, question: "Push fix/evict-order and open a pull request?", options: [{ label: "Push" }] };
const TAG: ShownQuestion = { id: "q_2", askedAt: AT, question: "Tag it too?", options: [] };
const WORKER: ShownQuestion = { id: "plan:evict:0", askedAt: AT, question: "May I run the full build in a loop?", options: [], from: "upload-probe" };

test("a new question is announced politely, once; one that leaves or stays says nothing new", () => {
  const view = mount(<QuestionAnnouncer questions={[]} />);
  const status = () => view.host.querySelector<HTMLElement>('[data-slot="question-announcer"]')!;
  expect(status().getAttribute("role")).toBe("status");
  expect(status().getAttribute("aria-live")).toBe("polite");
  expect(status().textContent).toBe("");
  view.rerender(<QuestionAnnouncer questions={[PUSH]} />);
  expect(status().textContent).toBe("Needs your answer: Push fix/evict-order and open a pull request?");
  view.rerender(<QuestionAnnouncer questions={[PUSH, TAG]} />);
  expect(status().textContent).toBe("Needs your answer: Tag it too?");
  // The second answered: the first is not said again.
  view.rerender(<QuestionAnnouncer questions={[PUSH]} />);
  expect(status().textContent).toBe("Needs your answer: Tag it too?");
  view.rerender(<QuestionAnnouncer questions={[PUSH, TAG]} />);
  expect(status().textContent).toBe("Needs your answer: Tag it too?");
  // A worker's question is said with its worker.
  view.rerender(<QuestionAnnouncer questions={[TAG, WORKER]} />);
  expect(status().textContent).toBe("upload-probe is waiting for an answer: May I run the full build in a loop?");
});

test("a question already open when the conversation is opened is announced too; of two, the newer", () => {
  const view = mount(<QuestionAnnouncer questions={[PUSH]} />);
  expect(view.host.querySelector('[data-slot="question-announcer"]')!.textContent).toBe("Needs your answer: Push fix/evict-order and open a pull request?");
  runCleanups();
  const two = mount(<QuestionAnnouncer questions={[PUSH, TAG]} />);
  expect(two.host.querySelector('[data-slot="question-announcer"]')!.textContent).toBe("Needs your answer: Tag it too?");
});

test("a worker's next question in the same place of its plan is new: it is announced", () => {
  const view = mount(<QuestionAnnouncer questions={[WORKER]} />);
  const status = () => view.host.querySelector<HTMLElement>('[data-slot="question-announcer"]')!;
  view.rerender(<QuestionAnnouncer questions={[]} />);
  view.rerender(<QuestionAnnouncer questions={[{ ...WORKER, question: "May I bump the cache size?" }]} />);
  expect(status().textContent).toBe("upload-probe is waiting for an answer: May I bump the cache size?");
});

test("a new question worded as the last one is announced all the same: its words are put there anew", () => {
  const view = mount(<QuestionAnnouncer questions={[PUSH]} />);
  const status = () => view.host.querySelector<HTMLElement>('[data-slot="question-announcer"]')!;
  const before = status().firstElementChild;
  view.rerender(<QuestionAnnouncer questions={[]} />);
  view.rerender(<QuestionAnnouncer questions={[{ ...PUSH, id: "q_9" }]} />);
  expect(status().textContent).toBe("Needs your answer: Push fix/evict-order and open a pull request?");
  expect(status().firstElementChild === before).toBe(false);
  // Nothing new, nothing put there.
  const now = status().firstElementChild;
  view.rerender(<QuestionAnnouncer questions={[{ ...PUSH, id: "q_9" }]} />);
  expect(status().firstElementChild === now).toBe(true);
});

test("of several new at once, the one asked last is announced, whatever their order in the list", () => {
  const older = { ...WORKER, id: "plan:a:0", askedAt: "2026-01-12T14:00:00.000Z", from: "first-worker", question: "Older?" };
  const newer = { ...WORKER, id: "plan:b:0", askedAt: "2026-01-12T15:00:00.000Z", from: "second-worker", question: "Newer?" };
  const view = mount(<QuestionAnnouncer questions={[newer, older]} />);
  expect(view.host.querySelector('[data-slot="question-announcer"]')!.textContent).toBe("second-worker is waiting for an answer: Newer?");
});

test("a worker's question that moves up its plan, when one before it is cleared, is not said again", () => {
  const first = { ...WORKER, id: "plan:evict:0", question: "May I run the full build in a loop?" };
  const second = { ...WORKER, id: "plan:evict:1", question: "May I bump the cache size?" };
  const view = mount(<QuestionAnnouncer questions={[first, second]} />);
  const status = () => view.host.querySelector<HTMLElement>('[data-slot="question-announcer"]')!;
  const said = status().firstElementChild;
  // The first is cleared: the second is now the plan's first.
  view.rerender(<QuestionAnnouncer questions={[{ ...second, id: "plan:evict:0" }]} />);
  expect(status().firstElementChild === said).toBe(true);
});

