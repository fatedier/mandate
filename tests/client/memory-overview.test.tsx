import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { MemoryDreamRunDto, MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { OverviewView } from "@/routes/memory/OverviewView";
import type { DreamBatch } from "@/routes/memory/dream/memory-run-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Overview on the redesign's list language: six titled sections, each one
 * header line over one quiet panel. happy-dom performs no layout, so nothing
 * here reads a box — the assertions are section titles, row text, hrefs, and
 * the classes the spec fixes (status colour stays on the usage bar only).
 */

const STATS: MemoryStatsResponse = {
  totals: { available: 10, archived: 2, total: 12 },
  byScope: { user: 1, global: 1, project: 6, feature: 2 },
  byKind: { episodic: 3, semantic: 3, preference: 2, procedural: 2 },
  byProject: [
    { projectId: "p1", name: "golib", count: 7 },
    { projectId: "p2", name: "mandate", count: 3 }
  ],
  // Every band distinct, so a row reading the wrong one cannot pass by coincidence.
  usage: { used: 5, idle: 3, untouched: 2 }
};

let seq = 0;
function entry(over: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: `mem_${++seq}`,
    scope: "global",
    projectId: null,
    featureId: null,
    kind: "semantic",
    status: "available",
    content: `memory ${seq}`,
    strength: 1,
    confidence: 0.9,
    cues: [],
    source: "manual",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    lastRecalledAt: null,
    recallCount: 0,
    lastUsedAt: null,
    useCount: 0,
    feedback: {},
    metadata: null,
    ...over
  };
}

let runSeq = 0;
function run(over: Partial<MemoryDreamRunDto> = {}): MemoryDreamRunDto {
  return {
    id: `drm-${++runSeq}`,
    trigger: "idle",
    status: "succeeded",
    provider: "codex",
    model: "codex/gpt-5.6-sol",
    phase: "global",
    projectId: null,
    projectName: null,
    candidateCount: 0,
    appliedCount: 5,
    actionCount: 0,
    actionCounts: { keep: 3, update: 1, merge: 0, archive: 1, rescope: 0 },
    rejectedCount: 0,
    failedCount: 0,
    finishReason: null,
    error: null,
    metadata: null,
    startedAt: "2026-07-27T07:00:00.000Z",
    finishedAt: "2026-07-27T07:02:00.000Z",
    availableCountBefore: 0,
    availableCountAfter: 0,
    ...over
  };
}

const LAST_DREAM: DreamBatch = {
  id: "drm-1",
  startedAt: "2026-07-27T07:00:00.000Z",
  finishedAt: "2026-07-27T07:02:00.000Z",
  running: false,
  runs: [run({ phase: "project", projectId: "p1", projectName: "golib" }), run()]
};

const TOP_RECALLED = [
  entry({ useCount: 40, recallCount: 50, content: "first" }),
  entry({ useCount: 12, recallCount: 20, content: "second" }),
  entry({ useCount: 3, recallCount: 9, content: "third" })
];

const JUST_LEARNED = [
  entry({ content: "newest", createdAt: "2026-07-28T11:00:00.000Z" }),
  entry({ content: "older", createdAt: "2026-07-28T09:00:00.000Z" })
];

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(over: Partial<Parameters<typeof OverviewView>[0]> = {}): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <OverviewView
          stats={STATS}
          topRecalled={TOP_RECALLED}
          justLearned={JUST_LEARNED}
          lastDream={LAST_DREAM}
          loading={false}
          onRunDream={() => {}}
          running={false}
          {...over}
        />
      </MemoryRouter>
    );
  });
  return container;
}

const titles = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-slot="section-title"]')).map((t) => t.textContent);

// Throws by name on a miss: a renamed section then fails as "no section titled
// X", not as a TypeError on the next property read.
const sectionByTitle = (el: HTMLElement, title: string): HTMLElement => {
  const section = Array.from(el.querySelectorAll("section")).find(
    (s) => s.querySelector('[data-slot="section-title"]')?.textContent === title
  );
  if (!section) throw new Error(`no section titled ${title}`);
  return section;
};

test("overview is six sections on the list language; no blue links, no cards", async () => {
  const el = await render();
  expect(titles(el)).toEqual(["Memories", "Maintenance load", "Last dream", "What it leans on", "Where it lives", "Just learned"]);
  expect(el.querySelectorAll('[data-slot="section-panel"]').length).toBe(6);
  expect(el.innerHTML.includes("bg-card")).toBe(false);
  expect(el.innerHTML.includes("text-primary")).toBe(false);
  expect(el.querySelector(".label-micro") === null).toBe(true);
  // usage bar keeps its status colours
  const bar = el.querySelector('[role="img"][aria-label*="never recalled"]')!;
  expect(bar === null).toBe(false);
  expect(bar.innerHTML.includes("bg-live")).toBe(true);
  expect(bar.innerHTML.includes("bg-status-input")).toBe(true);
  expect(bar.innerHTML.includes("bg-destructive")).toBe(false);
  // section links are muted + chevron
  const links = Array.from(el.querySelectorAll('[data-slot="section-header"] a'));
  expect(links.length).toBeGreaterThanOrEqual(3);
  for (const a of links) expect(a.className.split(/\s+/)).toContain("text-muted-foreground");
  // Run now is a 28px outline button in the Last dream header line
  const run = Array.from(el.querySelectorAll('[data-slot="section-header"] button')).find((b) => b.textContent?.includes("Run now"))!;
  expect(run === undefined).toBe(false);
  expect(run.className.split(/\s+/)).toContain("h-7");
  expect((run as HTMLButtonElement).disabled).toBe(false);
  // scope bars are neutral
  expect(el.querySelector('[data-slot="scope-bar"]')!.className.split(/\s+/)).toContain("bg-faint");
  expect(el.querySelectorAll('[data-slot="scope-bar"]').length).toBe(4);
  // The paired sections sit in a grid that is one explicit column on a phone:
  // the implicit single track is `auto`, which sized to the widest line.
  for (const title of ["Maintenance load", "What it leans on"]) {
    const grid = sectionByTitle(el, title).parentElement!.className.split(/\s+/);
    // Two columns only when the PANE is wide, not the viewport: at the 50/50
    // split on a 1440 screen the pane is ~608px and two columns squeezed
    // "recalled into context, never once used" onto three lines.
    for (const t of ["grid", "grid-cols-1", "@min-[52rem]:grid-cols-2"]) expect(grid).toContain(t);
    expect(grid).not.toContain("md:grid-cols-2");
  }
});

test("the header lines carry the numbers the totals used to", async () => {
  const el = await render();
  const memories = sectionByTitle(el, "Memories");
  expect(memories.querySelector('[data-slot="section-meta"]')!.textContent).toBe("10 live · 2 archived · 12 ever learned");
  // idle 3 of 10 available = 30%, under the 50% alarm line, so neutral.
  const idle = memories.querySelector('[data-slot="idle-share"]')!;
  expect(idle.textContent).toBe("30% recalled, never used");
  expect(idle.className.split(/\s+/)).toContain("text-faint");
  expect(idle.className.split(/\s+/)).not.toContain("text-status-input");
  // One line, never squeezed: the meta beside it is what gives way.
  for (const t of ["shrink-0", "whitespace-nowrap"]) expect(idle.className.split(/\s+/)).toContain(t);

  // Backlog's number moved into the Maintenance load meta; the row keeps the count and its link.
  const load = sectionByTitle(el, "Maintenance load");
  expect(load.querySelector('[data-slot="section-meta"]')!.textContent).toBe("last pass changed 4 memories");
  const backlog = load.querySelector('[data-slot="section-row"]')!;
  // The count by name: the idle band, not the untouched one (2) or the used one (5).
  expect(backlog.querySelector(".num")!.textContent).toBe("3");
  expect(backlog.textContent).toContain("recalled into context, never once used");
  const see = backlog.querySelector("a")!;
  expect(see.textContent).toBe("See them");
  expect(new URL(see.href, "http://x").searchParams.get("usage")).toBe("idle");

  const dream = sectionByTitle(el, "Last dream");
  // formatRelativeTime against the real clock: the fixture is fixed, the day count is not.
  expect(dream.querySelector('[data-slot="section-meta"]')!.textContent).toMatch(/^\d+d ago$/);
  const rows = Array.from(dream.querySelectorAll('[data-slot="section-row"]'));
  expect(rows.length).toBe(2);
  expect(rows[0]!.textContent).toContain("2 partitions · 2m");
  expect(rows[0]!.textContent).toContain("10 reviewed · 4 changed");
  expect(rows[1]!.querySelector("a")!.textContent).toBe("See what changed");
});

test("idle share at or over half is the one status colour in the Memories header", async () => {
  const el = await render({ stats: { ...STATS, usage: { used: 2, idle: 6, untouched: 2 } } });
  const idle = sectionByTitle(el, "Memories").querySelector('[data-slot="idle-share"]')!;
  expect(idle.textContent).toBe("60% recalled, never used");
  expect(idle.className.split(/\s+/)).toContain("text-status-input");
});

test("a running dream retitles the section, keeps the live dot, and disables Run now", async () => {
  const el = await render({
    lastDream: { ...LAST_DREAM, finishedAt: null, running: true, runs: [run({ status: "running", finishedAt: null, appliedCount: 0 })] }
  });
  expect(titles(el)[2]).toBe("Dreaming now");
  const dream = sectionByTitle(el, "Dreaming now");
  expect(dream.innerHTML.includes("animate-live")).toBe(true);
  const rows = Array.from(dream.querySelectorAll('[data-slot="section-row"]'));
  expect(rows[0]!.textContent).toContain("1 partition");
  expect(rows[0]!.textContent).toContain("2 changed so far");
  expect(rows[1]!.querySelector("a")!.textContent).toBe("Watch it");
  const button = dream.querySelector('[data-slot="section-header"] button') as HTMLButtonElement;
  expect(button.textContent).toContain("Running");
  expect(button.disabled).toBe(true);
});

test("a run just requested disables Run now even while the last dream shows as finished", async () => {
  // `running` is the page's own in-flight flag; the batch it reads still says
  // finished until the next poll. The button must trust either signal.
  const el = await render({ running: true });
  expect(titles(el)[2]).toBe("Last dream");
  const button = sectionByTitle(el, "Last dream").querySelector('[data-slot="section-header"] button') as HTMLButtonElement;
  expect(button.textContent).toContain("Running");
  expect(button.disabled).toBe(true);
});

test("rows: use counts are neutral, scope rows link to Browse, learned rows show facets", async () => {
  const el = await render();
  const leans = sectionByTitle(el, "What it leans on");
  const leanRows = Array.from(leans.querySelectorAll('[data-slot="section-row"]'));
  expect(leanRows.map((r) => r.textContent)).toEqual(["40first", "12second", "3third"]);
  const count = leanRows[0]!.querySelector(".num")!;
  expect(count.className.split(/\s+/)).toContain("text-faint");
  expect(count.className.split(/\s+/)).not.toContain("text-live");
  expect(count.getAttribute("title")).toBe("used 40×, recalled 50×");
  expect(leans.querySelector('[data-slot="section-header"] a')!.textContent).toBe("All");

  const lives = sectionByTitle(el, "Where it lives");
  const scopeLinks = Array.from(lives.querySelectorAll('[data-slot="section-row"] a'));
  expect(scopeLinks.map((a) => new URL((a as HTMLAnchorElement).href, "http://x").searchParams.get("scope")))
    .toEqual(["feature", "project", "user", "global"]);
  expect(scopeLinks[1]!.textContent).toBe("project6");
  expect(lives.innerHTML.includes("bg-phase-")).toBe(false);
  expect(lives.querySelector('[data-slot="section-header"] a')!.textContent).toBe("Browse");

  const learned = sectionByTitle(el, "Just learned");
  expect(learned.querySelector('[data-slot="section-meta"]')!.textContent).toBe("newest first");
  const learnedRows = Array.from(learned.querySelectorAll('[data-slot="section-row"]'));
  expect(learnedRows.length).toBe(2);
  expect(learnedRows[0]!.querySelector("p")!.textContent).toBe("newest");
  expect(learnedRows[0]!.className.split(/\s+/)).toContain("min-h-13");
  expect(learned.querySelector('[data-slot="section-header"] a')!.textContent).toBe("Full activity");
});

test("empty states are one faint row each, and the meta is omitted with no dream", async () => {
  const el = await render({
    topRecalled: [],
    justLearned: [],
    lastDream: null,
    stats: { ...STATS, usage: { used: 10, idle: 0, untouched: 0 } }
  });
  expect(titles(el)).toEqual(["Memories", "Maintenance load", "Last dream", "What it leans on", "Where it lives", "Just learned"]);
  const load = sectionByTitle(el, "Maintenance load");
  expect(load.querySelector('[data-slot="section-meta"]') === null).toBe(true);
  expect(load.querySelector('[data-slot="section-row"]')!.textContent).toBe("Nothing is going unused.");
  const dream = sectionByTitle(el, "Last dream");
  expect(dream.querySelector('[data-slot="section-meta"]') === null).toBe(true);
  expect(dream.querySelector('[data-slot="section-row"]')!.textContent).toBe("No maintenance has run yet.");
  expect(sectionByTitle(el, "What it leans on").querySelector('[data-slot="section-row"]')!.textContent).toBe("Nothing has been used yet.");
  expect(sectionByTitle(el, "Just learned").querySelector('[data-slot="section-row"]')!.textContent).toBe("Nothing learned yet.");
  for (const row of ["Nothing is going unused.", "No maintenance has run yet.", "Nothing has been used yet.", "Nothing learned yet."]) {
    const node = Array.from(el.querySelectorAll('[data-slot="section-row"]')).find((r) => r.textContent === row)!;
    expect(node.innerHTML.includes("text-faint")).toBe(true);
  }
});

test("loading with no stats renders the skeleton as sections, not cards", async () => {
  const el = await render({ stats: null, loading: true });
  expect(el.querySelectorAll('[data-slot="section-panel"]').length).toBe(2);
  expect(el.innerHTML.includes("bg-card")).toBe(false);
  expect(el.innerHTML.includes("bg-sel")).toBe(true);
});
