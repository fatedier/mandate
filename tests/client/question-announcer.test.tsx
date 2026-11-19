import { expect, test } from "bun:test";
import { QuestionAnnouncer } from "@/routes/window/chat/QuestionAnnouncer";
import type { OpenQuestion } from "@shared/questions";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// A question appearing above the composer is said aloud to a screen reader:
// once, when it is new.

const AT = "2026-01-12T14:00:00.000Z";
const PUSH: OpenQuestion = { id: "q_1", askedAt: AT, question: "Push fix/evict-order and open a pull request?", options: [{ label: "Push" }] };
const TAG: OpenQuestion = { id: "q_2", askedAt: AT, question: "Tag it too?", options: [] };

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
});

test("a question already open when the conversation is opened is announced too; of two, the newer", () => {
  const view = mount(<QuestionAnnouncer questions={[PUSH]} />);
  expect(view.host.querySelector('[data-slot="question-announcer"]')!.textContent).toBe("Needs your answer: Push fix/evict-order and open a pull request?");
  runCleanups();
  const two = mount(<QuestionAnnouncer questions={[PUSH, TAG]} />);
  expect(two.host.querySelector('[data-slot="question-announcer"]')!.textContent).toBe("Needs your answer: Tag it too?");
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
  const older = { ...TAG, id: "q_a", askedAt: "2026-01-12T14:00:00.000Z", question: "Older?" };
  const newer = { ...TAG, id: "q_b", askedAt: "2026-01-12T15:00:00.000Z", question: "Newer?" };
  const view = mount(<QuestionAnnouncer questions={[newer, older]} />);
  expect(view.host.querySelector('[data-slot="question-announcer"]')!.textContent).toBe("Needs your answer: Newer?");
});
