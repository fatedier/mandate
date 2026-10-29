import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { FeaturePlanCard } from "@/routes/window/plan/FeaturePlanCard";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { emptyPlan, type FeaturePlanDto, type PlanStepDto } from "@shared/api/plans";
import { planForPage } from "@shared/plan-rounds";
import { useSnapshotStore } from "@/store/snapshot";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mount, settle, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;

const fetched: string[] = [];

beforeEach(() => {
  // The card fetches its own plan and work item; answer both with "not found"
  // so what a test seeded in the stores is what the card shows.
  mockFetch(({ url }) => {
    fetched.push(url);
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  });
});

afterEach(() => {
  // Unmount before the stores the card reads are reset under it.
  runCleanups();
  useFeaturePlansStore.setState({ plans: new Map() });
  useSnapshotStore.setState({ snapshot: null });
  fetched.length = 0;
});

function render(ui: React.ReactNode) {
  view = mount(<MemoryRouter>{ui}</MemoryRouter>);
}

const q = (selector: string, from: ParentNode = document) => from.querySelector(selector)!;
const all = (selector: string) => [...document.querySelectorAll(selector)];
const click = (el: Element) => act(() => (el as HTMLElement).click());

// Timestamps the card shows as dates are noon UTC, so the day reads the same in
// every timezone the suite runs in.
const step = (id: number, status: PlanStepDto["status"], extra: Partial<PlanStepDto> = {}): PlanStepDto => ({
  id, title: `step ${id}`, status, note: null, createdAt: "2026-09-10T12:00:00.000Z", startedAt: null,
  blockedAt: null, completedAt: null, updatedAt: "2026-09-14T12:00:00.000Z", ...extra
});
const plan: FeaturePlanDto = {
  ...emptyPlan("feat_1"),
  goal: "Release entries on a short TTL",
  conclusion: "Waiting on upstream project-2",
  openQuestions: ["Split the cache into its own PR?"],
  steps: [
    ...Array.from({ length: 7 }, (_, i) => step(i + 1, "done", { note: i === 6 ? "merged in c0ffee1, see %133" : "ok", completedAt: `2026-09-1${i}T12:00:00.000Z` })),
    step(8, "blocked", { note: "project-2#17", blockedAt: "2026-09-14T12:00:00.000Z" }),
    step(9, "pending")
  ],
  updatedAt: "2026-09-14T12:00:00.000Z"
};
const props = { featureId: "feat_1", projectSlug: "project-1", featureSlug: "project-2", gitRemote: "git@github.com:acmecorp/project-1.git", canvasTitles: new Map<string, string>() };

test("the card shows state, conclusion, progress, goal, questions and folded steps", () => {
  // A step's date leaves out this year: pin "this year" to the fixture's.
  setSystemTime(new Date("2026-10-08T12:00:00"));
  onCleanup(() => setSystemTime());
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  // Its plan asks a question and the worker rests: it waits for the answer.
  expect(q('[data-slot="feature-state"]').textContent).toBe("Waiting for an answer");
  expect(q('[data-slot="plan-conclusion"]').textContent).toBe("Waiting on upstream project-2");
  expect(q('[data-slot="plan-progress"]').textContent).toBe("7 of 9 done");
  // As steps get done, the bar grows to them gently (at once with less motion asked for).
  expect(q('[data-slot="plan-progress-fill"]').getAttribute("class")!.split(/\s+/)).toEqual(expect.arrayContaining(["transition-[width,background-color]", "motion-reduce:transition-none"]));
  expect(q('[data-slot="plan-goal"]').textContent).toBe("Release entries on a short TTL");
  expect(q('[data-slot="plan-questions"]').textContent).toContain("Split the cache into its own PR?");
  expect(all('[data-slot="plan-step"]').map((el) => el.getAttribute("data-step-id"))).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
  expect(q('[data-slot="plan-step"][data-step-id="8"] [data-slot="plan-step-meta"]').textContent).toBe("since Sep 14");
});

// "2 steps done earlier" read as a note: no chevron, no verb, and once open
// nothing folded the steps again. It is a toggle written like
// the panel's "› Archived".
test("the earlier done steps fold behind a toggle that opens and closes", () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  const toggle = () => q('[data-slot="plan-earlier"]');
  expect(toggle().textContent).toBe("Show 2 earlier steps");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(q("svg", toggle()).getAttribute("class")).not.toContain("rotate-90");
  click(toggle());
  expect(all('[data-slot="plan-step"]').length).toBe(9);
  expect(toggle().textContent).toBe("Hide earlier steps");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(q("svg", toggle()).getAttribute("class")).toContain("rotate-90");
  click(toggle());
  expect(all('[data-slot="plan-step"]').length).toBe(7);
  expect(toggle().textContent).toBe("Show 2 earlier steps");
});

// A worker that changed its goal started new work: the card shows that work,
// and the earlier goals' finished steps fold into one row, by goal.
const at = (h: number) => `2026-10-12T${String(h).padStart(2, "0")}:00:00.000Z`;
const reAimed: FeaturePlanDto = {
  ...emptyPlan("feat_1"),
    goal: "Find why the image build fails",
    goalHistory: [
      { goal: "Draft the release notes", changedAt: at(10) },
      { goal: "Open the release PR", changedAt: at(12) }
    ],
    steps: [
      step(1, "done", { createdAt: at(8), completedAt: at(8) }),
      step(2, "done", { createdAt: at(9), completedAt: at(9) }),
      step(3, "pending", { createdAt: at(9) }),
      step(4, "done", { createdAt: at(10), completedAt: at(11) }),
      step(5, "done", { createdAt: at(12), completedAt: at(13) }),
      step(6, "in_progress", { createdAt: at(12), startedAt: at(13) })
    ],
    updatedAt: at(13)
};
const roundsShown = () => all('[data-slot="plan-earlier-round"]').map((round) => ({
  goal: q('[data-slot="plan-round-goal"]', round).textContent,
  title: q('[data-slot="plan-round-goal"]', round).getAttribute("title"),
  meta: q('[data-slot="plan-round-meta"]', round).textContent,
  steps: [...round.querySelectorAll('[data-slot="plan-step"]')].map((el) => el.getAttribute("data-step-id"))
}));
const ROUNDS = [
  { goal: "Draft the release notes", title: "Draft the release notes", meta: "2 steps · Oct 12", steps: ["1", "2"] },
  { goal: "Open the release PR", title: "Open the release PR", meta: "1 step · Oct 12", steps: ["4"] }
];

test("a plan re-aimed shows its current work, and earlier work folds by the goal it served", () => {
  setSystemTime(new Date("2026-10-14T12:00:00"));
  onCleanup(() => setSystemTime());
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", reAimed]]) });
  render(<FeaturePlanCard {...props} />);
  expect(q('[data-slot="plan-progress"]').textContent).toBe("1 of 3 done");
  const listed = () => all('[data-slot="plan-step"]').map((el) => el.getAttribute("data-step-id"));
  // A step still open from before stays in the current work.
  expect(listed()).toEqual(["3", "5", "6"]);
  const toggle = () => q('[data-slot="plan-earlier-work"]');
  expect(toggle().textContent).toBe("Earlier work · 2 goals, 3 steps");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[data-slot="plan-earlier-round"]') === null).toBe(true);
  click(toggle());
  expect(toggle().textContent).toBe("Hide earlier work");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(roundsShown()).toEqual(ROUNDS);
  expect(listed()).toEqual(["1", "2", "4", "3", "5", "6"]);
  click(toggle());
  expect(listed()).toEqual(["3", "5", "6"]);
});

// The page receives the current work and earlier work counted; it reads the
// whole plan when earlier work is opened, and again when the plan moves on.
test("from the page's plan, earlier work is counted, and opening it reads the whole plan", async () => {
  setSystemTime(new Date("2026-10-14T12:00:00"));
  onCleanup(() => setSystemTime());
  let whole: FeaturePlanDto = reAimed;
  let failNext = false;
  const historyReads: string[] = [];
  mockFetch(({ url }) => {
    if (url.endsWith("/api/features/feat_1/plan?history=1")) {
      historyReads.push(url);
      if (failNext) { failNext = false; return new Response(JSON.stringify({ error: "database is locked" }), { status: 500 }); }
      return jsonResponse({ plan: whole });
    }
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  });
  // Just re-aimed, nothing written for the new goal yet: the current work is
  // the step still open from before, and its note names a later step.
  const sent = planForPage({ ...reAimed, steps: reAimed.steps.filter((s) => s.id <= 4).map((s) => s.id === 3 ? { ...s, note: "compare with #4, see #9" } : s) });
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", sent]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  const toggle = () => q('[data-slot="plan-earlier-work"]');
  expect(toggle().textContent).toBe("Earlier work · 2 goals, 3 steps");
  expect(historyReads).toStrictEqual([]);
  expect(all('[data-slot="plan-step"]').map((el) => el.getAttribute("data-step-id"))).toEqual(["3"]);
  // #4 is an earlier step, past every id the page has: still a step, not an issue.
  click(q('[data-slot="plan-step"][data-step-id="3"] button'));
  expect(document.querySelector('[data-slot="plan-step"][data-step-id="3"] a[href$="/issues/4"]') === null).toBe(true);
  expect(document.querySelector('[data-slot="plan-step"][data-step-id="3"] a[href$="/issues/9"]')).not.toBeNull();
  failNext = true;
  click(toggle());
  await settle();
  expect(q('[data-slot="plan-earlier-error"]').textContent).toContain("Couldn't load earlier work.");
  click(q('[data-slot="plan-earlier-error"] button'));
  await settle();
  expect(roundsShown()).toEqual(ROUNDS);
  expect(historyReads).toHaveLength(2);
  // The plan moves on while open: earlier work is read again.
  whole = { ...reAimed, goalHistory: [...reAimed.goalHistory, { goal: "Find why the image build fails", changedAt: at(14) }], goal: "Write it up", updatedAt: at(14),
    steps: reAimed.steps.map((s) => ({ ...s, status: "done" as const, completedAt: s.completedAt ?? at(13) })) };
  await act(async () => { useFeaturePlansStore.getState().upsert(planForPage(whole)); });
  await settle();
  expect(historyReads).toHaveLength(3);
  expect(roundsShown().map((r) => r.steps)).toEqual([["1", "2", "3"], ["4"], ["5", "6"]]);
  expect(toggle().textContent).toBe("Hide earlier work");
});

// Re-aimed once: the row counts one goal in the singular, and opening it reads
// the whole plan once, for that goal's steps.
test("earlier work of one goal is one row with its counts, and opens to that goal's steps read from the server", async () => {
  const once: FeaturePlanDto = {
    ...emptyPlan("feat_1"),
    goal: "Find why the image build fails",
    goalHistory: [{ goal: "Draft the release notes", changedAt: at(10) }],
    steps: [
      step(1, "done", { createdAt: at(8), completedAt: at(8) }),
      step(2, "done", { createdAt: at(9), completedAt: at(9) }),
      step(3, "in_progress", { createdAt: at(10), startedAt: at(10) })
    ],
    updatedAt: at(10)
  };
  const historyReads: string[] = [];
  mockFetch(({ url }) => {
    if (url.endsWith("/api/features/feat_1/plan?history=1")) {
      historyReads.push(url);
      return jsonResponse({ plan: once });
    }
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  });
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", planForPage(once)]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  expect(q('[data-slot="plan-progress"]').textContent).toBe("0 of 1 done");
  expect(all('[data-slot="plan-step"]').map((el) => el.getAttribute("data-step-id"))).toEqual(["3"]);
  const toggle = () => q('[data-slot="plan-earlier-work"]');
  expect(toggle().textContent).toBe("Earlier work · 1 goal, 2 steps");
  expect(historyReads).toStrictEqual([]);
  click(toggle());
  await settle();
  expect(roundsShown().map((round) => [round.goal, round.steps])).toEqual([["Draft the release notes", ["1", "2"]]]);
  expect(historyReads).toHaveLength(1);
});

test("a step opens to its full note and times, and its pane and commit are links", () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  const row = () => q('[data-slot="plan-step"][data-step-id="7"]');
  // A done step's note waits for the step to be opened.
  expect(row().querySelector('[data-slot="plan-note"]') === null).toBe(true);
  click(q("button", row()));
  expect(q("button", row()).getAttribute("aria-expanded")).toBe("true");
  expect(q('[data-slot="plan-note"]', row()).className).not.toContain("line-clamp");
  expect(q('[data-slot="plan-step-times"]', row()).textContent).toContain("Done");
  // Each time to the minute: the second is not worth the room.
  expect(q('[data-slot="plan-step-times"]', row()).textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  expect(q('a[href="/projects/project-1/features/project-2/pane/%25133"]', row()).textContent).toBe("%133");
  expect(q('a[href="https://github.com/acmecorp/project-1/commit/c0ffee1"]', row()) === null).toBe(false);
});

test("an in-progress step shows how long it has run", () => {
  // Half an hour past 2h: the shared age clock may be a tick (15s) behind.
  const started = new Date(Date.now() - 2.5 * 3_600_000).toISOString();
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...plan, steps: [step(1, "in_progress", { startedAt: started })] }]]) });
  render(<FeaturePlanCard {...props} />);
  expect(q('[data-slot="plan-step-meta"]').textContent).toBe("started 2h ago");
});

test("no questions, no questions block; no plan, the planning line once the fetch says so", async () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...plan, openQuestions: [] }]]) });
  render(<FeaturePlanCard {...props} />);
  expect(document.querySelector('[data-slot="plan-questions"]') === null).toBe(true);
  view!.unmount();
  useFeaturePlansStore.setState({ plans: new Map() });
  mockFetch(({ url }) => url.includes("/plan")
    ? jsonResponse({ plan: emptyPlan("feat_2") })
    : jsonResponse({ error: "not in this test" }, 404));
  render(<FeaturePlanCard {...props} featureId="feat_2" />);
  await settle();
  expect(q('[data-slot="feature-state"]').textContent).toBe("Planning");
  expect(q('[data-slot="plan-conclusion"]').textContent).toBe("No plan yet — the worker writes one when it starts.");
  expect(document.querySelector('[data-slot="plan-progress"]') === null).toBe(true);
});

test("while the plan is still fetching, the card says Loading… and claims neither a plan nor a state", () => {
  mockFetch(() => new Promise<Response>(() => {}));
  render(<FeaturePlanCard {...props} featureId="feat_2" />);
  expect(q('[data-slot="plan-card"] [data-slot="loading-line"]').textContent).toBe("Loading…");
  expect(document.body.textContent).not.toContain("No plan yet");
  expect(document.querySelector('[data-slot="feature-state"]') === null).toBe(true);
});

test("a failed plan fetch is the inline error, not \"No plan yet\"; Retry fetches again", async () => {
  let planCalls = 0;
  mockFetch(({ url }) => {
    if (!url.includes("/plan")) return jsonResponse({ error: "not in this test" }, 404);
    planCalls += 1;
    return planCalls === 1 ? jsonResponse({ error: "database is locked" }, 500) : jsonResponse({ plan: emptyPlan("feat_2") });
  });
  render(<FeaturePlanCard {...props} featureId="feat_2" />);
  await settle();
  const failed = q('[data-slot="plan-card"] [data-slot="inline-error"]');
  expect(failed.textContent).toContain("Couldn't load the plan.");
  expect(failed.querySelector("p")!.textContent).toBe("database is locked");
  expect(document.body.textContent).not.toContain("No plan yet");
  expect(document.querySelector('[data-slot="feature-state"]') === null).toBe(true);
  await click([...failed.querySelectorAll("button")].find((b) => b.textContent === "Retry")!);
  await settle();
  expect(planCalls).toBe(2);
  expect(document.querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(q('[data-slot="plan-conclusion"]').textContent).toBe("No plan yet — the worker writes one when it starts.");
});

test("a plan already pushed shows even when the fetch fails", async () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  expect(q('[data-slot="plan-conclusion"]').textContent).toBe("Waiting on upstream project-2");
  expect(document.querySelector('[data-slot="inline-error"]') === null).toBe(true);
});

test("a report link opens the modal on a plain click and leaves a modified click to the browser", () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...plan, steps: [step(1, "in_progress", { note: "see cnv_AbCdEfGhIjK" })] }]]) });
  render(<FeaturePlanCard {...props} canvasTitles={new Map([["cnv_AbCdEfGhIjK", "TTL analysis"]])} />);
  const link = q('a[href="/canvas/cnv_AbCdEfGhIjK"]');
  expect(link.textContent).toBe("TTL analysis");
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
  act(() => { link.dispatchEvent(modified); });
  expect(modified.defaultPrevented).toBe(false);
  const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
  act(() => { link.dispatchEvent(plain); });
  expect(plain.defaultPrevented).toBe(true);
});

test("the card fetches its feature's plan and work item, so a feature outside the startup lists still reads right", () => {
  render(<FeaturePlanCard {...props} />);
  expect(fetched.some((u) => u.includes("/api/features/feat_1/plan"))).toBe(true);
  expect(fetched.some((u) => u.includes("featureId=feat_1"))).toBe(true);
});

test("a pane in another feature links to that feature's pane route", () => {
  useSnapshotStore.setState({ snapshot: { sessions: [{ sessionName: "other-project", windows: [{ windowName: "other-feature", panes: [
    { paneId: "%77", sessionName: "other-project", windowName: "other-feature", metadata: { name: "Other pane", description: "", updatedAt: "" } }
  ] }] }] } });
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...plan, steps: [step(1, "in_progress", { note: "running in %77" })] }]]) });
  render(<FeaturePlanCard {...props} />);
  const link = q('a[href="/projects/other-project/features/other-feature/pane/%2577"]');
  expect(link.textContent).toBe("Other pane");
});

test("a plan without a conclusion shows no headline, and never says there is no plan", () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...emptyPlan("feat_1"), goal: "Ship A", updatedAt: "2026-09-14T12:00:00.000Z" }]]) });
  render(<FeaturePlanCard {...props} />);
  expect(document.querySelector('[data-slot="plan-conclusion"]') === null).toBe(true);
  expect(document.body.textContent).not.toContain("No plan yet");
  expect(q('[data-slot="plan-goal"]').textContent).toBe("Ship A");
});

test("a note's #N that names one of the plan's steps is not linked as an issue; a larger one is", () => {
  const steps = [step(1, "done", { note: "ok", completedAt: "2026-09-12T12:00:00.000Z" }), step(2, "blocked", { note: "waits on #1 and upstream #34", blockedAt: "2026-09-14T12:00:00.000Z" })];
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...plan, steps }]]) });
  render(<FeaturePlanCard {...props} />);
  const row = q('[data-slot="plan-step"][data-step-id="2"]');
  expect(q('a[href="https://github.com/acmecorp/project-1/issues/1"]', row) === null).toBe(true);
  expect(q('a[href="https://github.com/acmecorp/project-1/issues/34"]', row) === null).toBe(false);
});

// On the worker page the tab names the plan and the page header carries the
// state, so the card opens on its content, not a "Plan" heading.
// Where the card shows the state (the panel, an archived worker) the header
// line stays to hold it.
test("without its state the card has no header line; with it, the header holds the state", () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} showState={false} />);
  expect(document.querySelector('section[aria-label="Plan"] [data-slot="section-header"]') === null).toBe(true);
  expect(q('[data-slot="plan-conclusion"]').textContent).toBe("Waiting on upstream project-2");
  view!.unmount();
  render(<FeaturePlanCard {...props} />);
  const header = q('section[aria-label="Plan"] [data-slot="section-header"]');
  expect(header.querySelector('[data-slot="section-title"]')!.textContent).toBe("Plan");
  expect(header.querySelector('[data-slot="feature-state"]')!.textContent).toBe("Waiting for an answer");
  // The same plan with nothing asked reads by its steps.
  view!.unmount();
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...plan, openQuestions: [] }]]) });
  render(<FeaturePlanCard {...props} />);
  expect(q('[data-slot="feature-state"]').textContent).toBe("Blocked");
});

test("an open question is drawn as the chat draws it: its canvas link is a link", () => {
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", { ...plan, openQuestions: ["Follow [the rollout plan](/canvas/cnv_P8sV2mQ0rTe) or ship **all at once**?"] }]]) });
  render(<FeaturePlanCard {...props} />);
  const questions = q('[data-slot="plan-questions"]');
  const link = questions.querySelector<HTMLAnchorElement>("a")!;
  expect([link.textContent, link.getAttribute("href"), questions.querySelector("strong")?.textContent]).toEqual(["the rollout plan", "/canvas/cnv_P8sV2mQ0rTe", "all at once"]);
  expect(questions.textContent).not.toContain("](");
});

// ---- The worker's task record, on its Plan tab ----

const RECORD = { id: "mem_rec1", content: "Export rows to CSV\n\n- **Done:** every step, shipped", updatedAt: "2026-10-14T09:00:00.000Z" };

function answerRecord(answers: Array<() => Response>) {
  const reads: string[] = [];
  mockFetch(({ url }) => {
    if (url.endsWith("/api/features/feat_1/record")) {
      reads.push(url);
      return (answers.length > 1 ? answers.shift()! : answers[0]!)();
    }
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  });
  return reads;
}

test("the plan card shows the work record folded: U1 · U2 and its first line", async () => {
  setSystemTime(new Date("2026-10-14T12:30:00.000Z"));
  onCleanup(() => setSystemTime());
  answerRecord([() => jsonResponse({ record: RECORD })]);
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  const row = q('[data-slot="plan-work-record"]');
  expect(row.textContent).toBe("Work record · Updated 3h ago");
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(q('[data-slot="plan-work-record-first-line"]').textContent).toBe("Export rows to CSV");
  expect(document.querySelector('[data-slot="plan-work-record-body"] strong') === null).toBe(true);
});

test("opening it shows the whole record as Markdown and fetches it again", async () => {
  setSystemTime(new Date("2026-10-14T12:30:00.000Z"));
  onCleanup(() => setSystemTime());
  const reads = answerRecord([() => jsonResponse({ record: RECORD })]);
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  expect(reads).toHaveLength(1);
  click(q('[data-slot="plan-work-record"]'));
  await settle();
  expect(q('[data-slot="plan-work-record"]').getAttribute("aria-expanded")).toBe("true");
  expect(q('[data-slot="plan-work-record-body"] strong').textContent).toBe("Done:");
  expect(q('[data-slot="plan-work-record-body"]').textContent).toContain("every step, shipped");
  expect(reads).toHaveLength(2);
});

// Extraction rewrites the record when the worker's window is compacted or
// archived: the row shows the rewrite while it is on screen.
test("the row reads its record again when it is rewritten, and after the event stream comes back", async () => {
  setSystemTime(new Date("2026-10-14T12:30:00.000Z"));
  onCleanup(() => setSystemTime());
  const rewritten = { ...RECORD, content: "Export rows to CSV and JSON\n\n- **Done:** both formats", updatedAt: "2026-10-14T12:00:00.000Z" };
  const reads = answerRecord([() => jsonResponse({ record: RECORD }), () => jsonResponse({ record: rewritten })]);
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  expect(reads).toHaveLength(1);
  act(() => { window.dispatchEvent(new CustomEvent("mandate:feature-record-updated", { detail: { featureId: "feat_2" } })); });
  await settle();
  expect(reads).toHaveLength(1);
  act(() => { window.dispatchEvent(new CustomEvent("mandate:feature-record-updated", { detail: { featureId: "feat_1" } })); });
  await settle();
  expect(reads).toHaveLength(2);
  expect(q('[data-slot="plan-work-record"]').textContent).toBe("Work record · Updated 30m ago");
  expect(q('[data-slot="plan-work-record-first-line"]').textContent).toBe("Export rows to CSV and JSON");
  act(() => { window.dispatchEvent(new CustomEvent("mandate:sse-open")); });
  await settle();
  expect(reads).toHaveLength(3);
});

test("no record, no row", async () => {
  const reads = answerRecord([() => jsonResponse({ record: null })]);
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  expect(reads).toHaveLength(1);
  expect(document.querySelector('[data-slot="plan-work-record"]') === null).toBe(true);
  expect(document.querySelector('[data-slot="plan-work-record-error"]') === null).toBe(true);
});

test("a failed fetch shows an inline error with retry", async () => {
  setSystemTime(new Date("2026-10-14T12:30:00.000Z"));
  onCleanup(() => setSystemTime());
  const reads = answerRecord([
    () => new Response(JSON.stringify({ error: "database is locked" }), { status: 500 }),
    () => jsonResponse({ record: RECORD })
  ]);
  useFeaturePlansStore.setState({ plans: new Map([["feat_1", plan]]) });
  render(<FeaturePlanCard {...props} />);
  await settle();
  expect(q('[data-slot="plan-work-record-error"]').textContent).toContain("Couldn't load the work record.");
  click(q('[data-slot="plan-work-record-error"] button'));
  await settle();
  expect(reads).toHaveLength(2);
  expect(q('[data-slot="plan-work-record"]').textContent).toBe("Work record · Updated 3h ago");
  expect(document.querySelector('[data-slot="plan-work-record-error"]') === null).toBe(true);
});
