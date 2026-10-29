import { describe, expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import type { MemoryDreamRunDto, MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { OverviewView } from "@/routes/memory/OverviewView";
import type { DreamBatch } from "@/routes/memory/dream/memory-run-model";
import { mountAsync } from "../helpers/mount.js";

/**
 * The Overview in the app's list language: four titled sections, each one
 * header line over one quiet panel; and its name-collision notice. happy-dom
 * performs no layout, so nothing here reads a box — the assertions are section
 * titles, row text, hrefs, and the classes the design fixes.
 */

const STATS: MemoryStatsResponse = {
  totals: { available: 10, archived: 2, total: 12 },
  byScope: { user: 2, project: 8 },
  byType: { preference: 4, knowledge: 3 },
  bySource: { user: 0, agent: 10, extraction: 0 },
  byProject: [
    { projectId: "p1", name: "project-3", count: 7 },
    { projectId: "p2", name: "mandate", count: 3 }
  ],
  // Every band distinct, so a row reading the wrong one cannot pass by coincidence.
  projectNames: { p1: "project-3", p2: "mandate" }
};

let seq = 0;
function entry(over: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: `mem_${++seq}`,
    scope: "user",
    projectId: null,
    featureId: null,
    type: "knowledge",
    status: "available",
    content: `memory ${seq}`,
    source: "agent",
    userQuote: null,
    sourceThreadId: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
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
    phase: "user",
    projectId: null,
    projectName: null,
    candidateCount: 0,
    appliedCount: 5,
    actionCount: 0,
    actionCounts: { update: 1, merge: 0, archive: 1, move: 0, split: 0 },
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
  runs: [run({ phase: "project", projectId: "p1", projectName: "project-3" }), run()]
};

const JUST_LEARNED = [
  entry({ content: "newest", createdAt: "2026-07-28T11:00:00.000Z" }),
  entry({ content: "older", createdAt: "2026-07-28T09:00:00.000Z" })
];

async function render(over: Partial<Parameters<typeof OverviewView>[0]> = {}): Promise<HTMLElement> {
  const { host } = await mountAsync(
    <MemoryRouter>
      <OverviewView
        stats={STATS}
        justLearned={JUST_LEARNED}
        lastDream={LAST_DREAM}
        loading={false}
        onRunDream={() => {}}
        running={false}
        {...over}
      />
    </MemoryRouter>
  );
  return host;
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

test("overview is the briefs, the store, the last dream and what it just learned; no blue links, no cards", async () => {
  const el = await render({ briefs: [] });
  expect(titles(el)).toEqual(["Briefs", "Memories", "Last dream", "Just learned"]);
  expect(el.querySelectorAll('[data-slot="section-panel"]').length).toBe(4);
  expect(el.innerHTML.includes("bg-card")).toBe(false);
  expect(el.innerHTML.includes("text-primary")).toBe(false);
  // section links are muted + chevron
  const links = Array.from(el.querySelectorAll('[data-slot="section-header"] a'));
  expect(links.length).toBeGreaterThanOrEqual(1);
  for (const a of links) expect(a.className.split(/\s+/)).toContain("text-muted-foreground");
  // Run now is a 28px outline button in the Last dream header line
  const run = Array.from(el.querySelectorAll('[data-slot="section-header"] button')).find((b) => b.textContent?.includes("Run now"))!;
  expect(run === undefined).toBe(false);
  expect(run.className.split(/\s+/)).toContain("h-7");
  expect((run as HTMLButtonElement).disabled).toBe(false);
  // The paired sections sit in a grid that is one explicit column on a phone:
  // the implicit single track is `auto`, which sized to the widest line.
  for (const title of ["Memories", "Last dream"]) {
    const grid = sectionByTitle(el, title).parentElement!.className.split(/\s+/);
    // Two columns only when the PANE is wide, not the viewport: at the 50/50
    // split on a 1440 screen the pane is ~608px and two columns squeeze
    // each section's rows onto several lines.
    for (const t of ["grid", "grid-cols-1", "@min-[52rem]:grid-cols-2"]) expect(grid).toContain(t);
    expect(grid).not.toContain("md:grid-cols-2");
  }
  // No briefs read yet: no section for them.
  expect(titles(await render())).toEqual(["Memories", "Last dream", "Just learned"]);
});

test("the header lines carry the numbers, and the last dream lists each partition's run", async () => {
  const el = await render();
  const memories = sectionByTitle(el, "Memories");
  expect(memories.querySelector('[data-slot="section-meta"]')!.textContent).toBe("10 live · 2 archived · 12 ever learned");
  const dream = sectionByTitle(el, "Last dream");
  // formatRelativeTime against the real clock: the fixture is weeks old, so
  // the date says when (with its year once the year has turned).
  expect(dream.querySelector('[data-slot="section-meta"]')!.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})? · 2m$/);
  const rows = Array.from(dream.querySelectorAll('[data-slot="section-row"]'));
  expect(rows.map((row) => row.textContent)).toEqual([
    "project-31 updated · 1 archivedtook 2m",
    "You1 updated · 1 archivedtook 2m"
  ]);
  for (const row of rows) expect(row.querySelector("button") === null).toBe(false);
  // On a narrow phone the name gives way and the duration steps aside, so the
  // tally keeps its room and nothing is clipped at the panel's edge.
  const pill = rows[0]!.querySelector("button > span")!.className.split(/\s+/);
  expect(pill).toContain("min-w-0");
  expect(pill).toContain("shrink");
  expect(rows[0]!.querySelector('[data-slot="run-took"]')!.className.split(/\s+/)).toContain("@max-[24rem]:hidden");
});

test("a running dream retitles the section, keeps the live dot, and disables Run now", async () => {
  const el = await render({
    lastDream: { ...LAST_DREAM, finishedAt: null, running: true, runs: [run({ status: "running", finishedAt: null, appliedCount: 0, actionCounts: { update: 0, merge: 0, archive: 0, move: 0, split: 0 } })] }
  });
  expect(titles(el)[1]).toBe("Dreaming now");
  const dream = sectionByTitle(el, "Dreaming now");
  expect(dream.innerHTML.includes("animate-live")).toBe(true);
  const rows = Array.from(dream.querySelectorAll('[data-slot="section-row"]'));
  expect(rows[0]!.textContent).toContain("working…");
  const button = dream.querySelector('[data-slot="section-header"] button') as HTMLButtonElement;
  expect(button.textContent).toContain("Running");
  expect(button.disabled).toBe(true);
});

test("a run just requested disables Run now even while the last dream shows as finished", async () => {
  // `running` is the page's own in-flight flag; the batch it reads still says
  // finished until the next poll. The button must trust either signal.
  const el = await render({ running: true });
  expect(titles(el)[1]).toBe("Last dream");
  const button = sectionByTitle(el, "Last dream").querySelector('[data-slot="section-header"] button') as HTMLButtonElement;
  expect(button.textContent).toContain("Running");
  expect(button.disabled).toBe(true);
});

test("rows: type and scope keys link to Browse, learned rows show facets and open", async () => {
  const el = await render();
  const keys = Array.from(sectionByTitle(el, "Memories").querySelectorAll("a"));
  expect(keys.map((a) => a.textContent)).toEqual(["4preferences", "3knowledge", "2yours", "8in 2 projects"]);
  const param = (a: Element, key: string) => new URL((a as HTMLAnchorElement).href, "http://x").searchParams.get(key);
  expect(keys.slice(0, 2).map((a) => param(a, "type"))).toEqual(["preference", "knowledge"]);
  expect(keys.slice(2).map((a) => param(a, "scope"))).toEqual(["user", "project"]);

  const learned = sectionByTitle(el, "Just learned");
  expect(learned.querySelector('[data-slot="section-meta"]')!.textContent).toBe("newest first");
  const learnedRows = Array.from(learned.querySelectorAll('[data-slot="section-row"]'));
  expect(learnedRows.length).toBe(2);
  expect(learnedRows[0]!.querySelector('[data-slot="memory-preview"]')!.textContent).toBe("newest");
  expect(learnedRows[0]!.querySelector("button")!.className.split(/\s+/)).toContain("min-h-13");
  expect(learned.querySelector('[data-slot="section-header"] a')!.textContent).toBe("Full activity");
});

test("empty states are one faint row each, and the meta is omitted with no dream", async () => {
  const el = await render({
    justLearned: [],
    lastDream: null
  });
  expect(titles(el)).toEqual(["Memories", "Last dream", "Just learned"]);
  const dream = sectionByTitle(el, "Last dream");
  expect(dream.querySelector('[data-slot="section-meta"]') === null).toBe(true);
  expect(dream.querySelector('[data-slot="section-row"]')!.textContent).toBe("No maintenance has run yet.");
  expect(sectionByTitle(el, "Just learned").querySelector('[data-slot="section-row"]')!.textContent).toBe("Nothing learned yet.");
  for (const row of ["No maintenance has run yet.", "Nothing learned yet."]) {
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

test("learned rows name their project, not its id, when the memory recorded no name", async () => {
  const el = await render({
    justLearned: [
      entry({ scope: "project", projectId: "p1", content: "tagged from main" }),
      entry({ scope: "project", projectId: "p2", featureId: "feat_gone", content: "close EvictHook" })
    ]
  });
  const facets = Array.from(sectionByTitle(el, "Just learned").querySelectorAll('[data-slot="section-row"] .text-chrome')).map((f) => f.textContent);
  expect(facets).toEqual(["knowledge · project-3", "knowledge · mandate"]);
});

/**
 * The name-collision notice, which had no test and said "2 … both" whatever
 * the real number was.
 *
 * happy-dom performs no layout, so nothing here reads a box: the assertions are
 * the badge's text, the sentence, and where the links point.
 */
describe("name collisions", () => {
  /** STATS with these projects. */
  function stats(byProject: MemoryStatsResponse["byProject"]): MemoryStatsResponse {
    return { ...STATS, byProject };
  }

  /** The Overview with nothing learned and no dream, so the notice is all
   *  these stats add. */
  function renderStats(data: MemoryStatsResponse): Promise<HTMLElement> {
    return render({ stats: data, justLearned: [], lastDream: null });
  }

  /**
   * The notice, found by the sentence only it renders.
   *
   * The first match in document order is the block holding the text and the
   * doors; its parent adds the count badge and nothing else. Going one level
   * further reaches the whole card, which carries the maintenance backlog's own
   * link — a scope wide enough to make the link assertions below pass on
   * somebody else's anchor.
   */
  function collisionRow(page: HTMLElement): HTMLElement | undefined {
    return [...page.querySelectorAll("div")].find(
      (node) => (node.textContent ?? "").startsWith("projects share the name")
    )?.parentElement ?? undefined;
  }

  test("a three-way collision says three, not two", async () => {
    // The bug this replaces: the count was the literal 2 and the sentence said
    // "both", so a third project holding the name was reported as a pair. The
    // fixture is three-way for exactly that reason — a two-way one passes
    // against the old hard-coded value.
    const page = await renderStats(stats([
      { projectId: "p1", name: "project-3", count: 7 },
      { projectId: "p2", name: "project-3", count: 3 },
      { projectId: "p3", name: "project-3", count: 1 }
    ]));
    const row = collisionRow(page)!;
    expect(row).toBeTruthy();
    // The badge is the sentence's first word, so it is asserted as text next to
    // the words that complete it rather than as a number on its own.
    expect(row.textContent).toContain("3projects share the name project-3");
  });

  test("each colliding project gets its own way in, filtered to that project", async () => {
    // The other half of the old bug: one link, to Browse filtered to every
    // project-scoped memory, where each row prints the project *name* — so the
    // two arrived indistinguishable, which is what the reader clicked to resolve.
    const page = await renderStats(stats([
      { projectId: "p1", name: "project-3", count: 7 },
      { projectId: "p2", name: "project-3", count: 3 }
    ]));
    const links = [...collisionRow(page)!.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["7 memories", "3 memories"]);
    // Distinct destinations, each naming its own project. Asserted as a pair
    // with the labels above: two links that read differently but point at the
    // same list would tell the reader nothing. The param is `project` — the URL
    // name, not the field name `browseHref` takes, which is `projectId`; reading
    // the wrong one returns null for both and the pair still looks equal.
    const target = (a: HTMLAnchorElement) => {
      const params = new URL(a.href, "http://x").searchParams;
      return `${params.get("view")}:${params.get("project")}`;
    };
    expect(links.map(target)).toEqual(["browse:p1", "browse:p2"]);
  });

  test("a project holding one memory is not pluralised", async () => {
    const page = await renderStats(stats([
      { projectId: "p1", name: "project-3", count: 1 },
      { projectId: "p2", name: "project-3", count: 4 }
    ]));
    expect([...collisionRow(page)!.querySelectorAll("a")].map((a) => a.textContent))
      .toEqual(["1 memory", "4 memories"]);
  });

  test("distinct names raise nothing", async () => {
    const page = await renderStats(stats([
      { projectId: "p1", name: "project-3", count: 7 },
      { projectId: "p2", name: "mandate", count: 3 }
    ]));
    expect(collisionRow(page) === undefined).toBe(true);
  });
});
