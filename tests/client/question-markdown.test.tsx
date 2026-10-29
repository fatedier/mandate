import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QuestionCallout } from "@/components/QuestionCallout";
import { AskLine } from "@/routes/window/chat/AskLine";
import { QuestionAnnouncer } from "@/routes/window/chat/QuestionAnnouncer";
import { QuestionDock } from "@/routes/window/chat/QuestionDock";
import { UserMessage } from "@/routes/window/chat/UserMessage";
import type { ShownQuestion } from "@/lib/shown-questions";
import type { HeldAnswers } from "@/routes/window/chat/useHeldAnswers";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// A question is written in Markdown, as the agent writes everything: where it
// stands in full it is drawn as the chat draws a reply (a canvas link opens
// the canvas over the page), and where it is one line, its words alone.

afterEach(runCleanups);

const CANVAS = "/canvas/cnv_P8sV2mQ0rTe";
const QUESTION = `Roll out **staged** per [Rollout plan](${CANVAS}), keeping \`cache.ttl\`?`;
const WORDS = "Roll out staged per Rollout plan, keeping cache.ttl?";
const AT = "2026-01-12T14:00:00.000Z";
const ASKED: ShownQuestion = { id: "q_1", askedAt: AT, question: QUESTION, options: [{ label: "**Staged**", description: "See [the plan](/canvas/cnv_P8sV2mQ0rTe) first" }, { label: "All at once" }] };

/** Where the router is: a canvas link opens the canvas in place. */
function Where() {
  const location = useLocation();
  return <output data-slot="where">{location.pathname}</output>;
}
const routed = (node: React.ReactNode) => (
  <MemoryRouter initialEntries={["/threads/thr_release"]}>
    <Routes><Route path="*" element={<>{node}<Where /></>} /></Routes>
  </MemoryRouter>
);
const slot = (host: ParentNode, name: string) => host.querySelector<HTMLElement>(`[data-slot="${name}"]`);

test("in full, the question is drawn as the chat draws a reply: its link opens the canvas in place, bold and code as such", async () => {
  const { host } = mount(routed(<QuestionCallout heading="Needs your answer" question={QUESTION} options={ASKED.options} onPick={() => {}} />));
  const text = slot(host, "question-text")!;
  expect(text.textContent).toBe(WORDS);
  expect([text.querySelector("strong")?.textContent, text.querySelector("code")?.textContent]).toEqual(["staged", "cache.ttl"]);
  const link = text.querySelector<HTMLAnchorElement>("a")!;
  expect([link.textContent, link.getAttribute("href")]).toEqual(["Rollout plan", CANVAS]);
  // The region is still described by the question.
  expect(slot(host, "question-dock")!.getAttribute("aria-describedby")).toBe(text.id);
  await act(async () => { link.click(); });
  expect(slot(host, "where")!.textContent).toBe(CANVAS);
});

test("a web link in a question one can answer by typing opens as a link does: nothing above it swallows the click", () => {
  const { host } = mount(routed(<QuestionCallout heading="Needs your answer" question="See [the changelog](https://example.com/changelog) first?" onSend={async () => {}} />));
  const link = slot(host, "question-text")!.querySelector<HTMLAnchorElement>("a")!;
  const click = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(click);
  expect([link.getAttribute("href"), click.defaultPrevented]).toEqual(["https://example.com/changelog", false]);
});

test("a suggested answer is a button: its words alone, no link inside it", () => {
  const { host } = mount(routed(<QuestionCallout heading="Needs your answer" question={QUESTION} options={ASKED.options} onPick={() => {}} />));
  const [first] = [...host.querySelectorAll<HTMLElement>('[data-slot="question-option"]')];
  expect([slot(first!, "question-option-label")!.textContent, slot(first!, "question-option-description")!.textContent, first!.querySelector("a") === null]).toEqual(["Staged", "See the plan first", true]);
});

test("on one line, a question is its words: a worker's card, the folded dock, the line where it was asked, the quote over an answer", async () => {
  const card = mount(routed(<QuestionCallout question={QUESTION} onSend={async () => {}} />));
  const line = card.host.querySelector<HTMLElement>('[data-slot="question-callout"] span[title]')!;
  expect([line.textContent, line.title]).toEqual([WORDS, WORDS]);

  const answers: HeldAnswers = { held: new Set(), pick: async () => null, refused: null, drafts: {}, setDraft: () => {} };
  const dock = mount(routed(<QuestionDock questions={[ASKED]} answers={answers} />));
  await act(async () => { dock.host.querySelector<HTMLElement>('[aria-label="Hide the question"]')!.click(); });
  expect(slot(dock.host, "question-reminder")!.textContent).toContain(WORDS);
  expect(slot(dock.host, "question-reminder")!.textContent).not.toContain("](");

  const asked = mount(<AskLine questionId="q_1" question={QUESTION} state="open" />);
  expect([slot(asked.host, "ask-line-question")!.textContent, slot(asked.host, "ask-line")!.title]).toEqual([WORDS, WORDS]);

  const quoted = mount(routed(<UserMessage text="Staged" status="persisted" answers={[{ id: "q_1", question: QUESTION }]} />));
  expect([slot(quoted.host, "answer-quote-text")!.textContent, slot(quoted.host, "answer-quote")!.title]).toEqual([WORDS, WORDS]);
});

test("a screen reader hears the question's words", () => {
  const { host } = mount(<QuestionAnnouncer questions={[ASKED]} />);
  expect(slot(host, "question-announcer")!.textContent).toBe(`Needs your answer: ${WORDS}`);
});
