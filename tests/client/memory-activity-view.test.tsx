import { afterEach, expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import type { MemoryDreamRunDto, MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { ActivityView } from "@/routes/memory/dream/ActivityView";
import { runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

/**
 * The activity feed on the list language: selection is a --sel fill, a kind is
 * not a colour, and a dream's partitions sit in a panel row rather than a
 * left-bordered card.
 *
 * happy-dom performs no layout, so nothing here reads a box: the assertions are
 * class tokens on the selected chip and the absence of the old vocabulary in
 * the rendered markup.
 */

let seq = 0;

function entry(over: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: `mem_${++seq}`,
    scope: "user",
    projectId: null,
    featureId: null,
    type: "knowledge",
    status: "available",
    content: "something",
    source: "agent",
    userQuote: null,
    sourceThreadId: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    metadata: null,
    ...over
  };
}

function run(
  startedAt: string,
  finishedAt: string | null,
  over: Partial<MemoryDreamRunDto> = {}
): MemoryDreamRunDto {
  return {
    id: `drm_${++seq}`,
    trigger: "idle",
    status: "succeeded",
    provider: "codex",
    model: "m",
    phase: "user",
    projectId: null,
    projectName: null,
    candidateCount: 3,
    appliedCount: 1,
    actionCount: 3,
    actionCounts: { update: 1, merge: 0, archive: 0, move: 0, split: 0 },
    rejectedCount: 0,
    failedCount: 0,
    finishReason: null,
    error: null,
    metadata: null,
    startedAt,
    finishedAt,
    availableCountBefore: null,
    availableCountAfter: null,
    ...over
  };
}

/** What the one learned entry is; a test may make it project-scoped. */
let learned: Partial<MemoryEntryDto> = {};
/** What the one dream run did; a test may change its counts. */
let dreamRun: Partial<MemoryDreamRunDto> = {};
/** The archived entries; a test may add a forgotten one. */
let archivedEntries: MemoryEntryDto[] = [];
let archivedUrl = "";
/** What an extraction rewrote last; a test may add one. */
let updatedEntries: MemoryEntryDto[] = [];
let updatedUrl = "";

/** One learned entry, nothing archived, one finished dream of one run. */
function bodyFor(url: string): unknown {
  if (url.includes("/dream/runs")) {
    return { runs: [run("2026-07-28T08:00:00.000Z", "2026-07-28T08:02:00.000Z", dreamRun)] };
  }
  if (url.includes("status=archived")) {
    archivedUrl = url;
    return { entries: archivedEntries };
  }
  if (url.includes("updated=1")) {
    updatedUrl = url;
    return { entries: updatedEntries };
  }
  // The parts a dream split off are left out before the limit, by the server.
  if (url.includes("status=all&learned=1")) return { entries: [entry(learned)] };
  // No silent `{ ok: true }`: a request this stub does not know is a request
  // the view makes that the test never modelled.
  throw new Error("unmocked fetch: " + url);
}

afterEach(() => {
  // Unmount and put fetch back before the fixture its stub reads is reset.
  runCleanups();
  learned = {};
  dreamRun = {};
  archivedEntries = [];
  updatedEntries = [];
});

async function render(stats: MemoryStatsResponse | null = null): Promise<HTMLElement> {
  mockFetch(({ url }) => new Response(JSON.stringify(bodyFor(url))));
  const { host } = await mountAsync(
    <MemoryRouter>
      <ActivityView stats={stats} />
    </MemoryRouter>
  );
  // The view loads on a zero timer; let it fire and the responses land.
  await settle(10);
  return host;
}

test("filter chips use --sel for the selected state; kinds are not coloured; the dream entry is a panel row, not a left-bordered card", async () => {
  const el = await render();
  // The fixture reached the feed: one learned event and one dream event, so
  // the assertions below cover the entry row, the dream row and its button.
  expect(el.textContent).toContain("Learned");
  expect(el.textContent).toContain("Dream");
  const selected = el.querySelector('button[aria-pressed="true"]');
  expect(selected === null).toBe(false);
  expect(selected?.textContent).toBe("Everything");
  const tokens = selected?.className.split(/\s+/) ?? [];
  for (const t of ["bg-sel", "text-foreground", "border-border"]) expect(tokens).toContain(t);
  expect(el.innerHTML.includes("border-primary")).toBe(false);
  expect(el.innerHTML.includes("text-primary")).toBe(false);
  expect(el.innerHTML.includes("border-l-2")).toBe(false);
  expect(el.innerHTML.includes("bg-card")).toBe(false);
});

test("outcomes keep their colour; the dream verb and the dream node do not", async () => {
  const el = await render();
  const verbs = Array.from(el.querySelectorAll("span.font-medium"));
  const learned = verbs.find((v) => v.textContent === "Learned");
  const dream = verbs.find((v) => v.textContent === "Dream");
  expect(learned?.className.split(/\s+/)).toContain("text-live");
  expect(dream?.className.split(/\s+/)).toContain("text-muted-foreground");
  expect(el.innerHTML.includes("bg-primary")).toBe(false);
});

test("a memory with no recorded name is labelled with its project's name, even when none of that project's memories is live", async () => {
  learned = { scope: "project", projectId: "proj_Ab3dEf6hIj9", content: "tagged from main" };
  const el = await render({
    totals: { available: 0, archived: 1, total: 1 },
    byScope: { user: 0, project: 0 },
    byType: { preference: 0, knowledge: 0 },
  bySource: { user: 0, agent: 0, extraction: 0 },
    // No live memory: byProject does not know it; the names map does.
    byProject: [],
    projectNames: { proj_Ab3dEf6hIj9: "project-1" }
  } satisfies MemoryStatsResponse);
  expect(el.textContent).toContain("knowledge · project-1");
  expect(el.textContent).not.toContain("proj_Ab3dEf6hIj9");
});

test("a dream that moved and split memories says so, and counts them as changes", async () => {
  dreamRun = { appliedCount: 2, actionCounts: { update: 0, merge: 0, archive: 0, move: 1, split: 1 } };
  const host = await render();
  expect(host.textContent).toContain("1 moved · 1 split");
  expect(host.textContent).toContain("2 changed");
  expect(host.textContent).not.toContain("nothing changed");
});

test("a forgotten memory is listed with the reason it was forgotten; a dream's archive is not", async () => {
  archivedEntries = [
    entry({ status: "archived", content: "the bridge fixes the leak", updatedAt: "2026-07-28T09:00:00.000Z", metadata: { forgottenReason: "proved wrong by the real E2E" } }),
    entry({ status: "archived", content: "merged by a dream", updatedAt: "2026-07-28T09:30:00.000Z", metadata: { mergedInto: "mem_x" } })
  ];
  const host = await render();
  expect(host.textContent).toContain("Forgotten");
  expect(host.querySelector('[data-slot="forgotten-reason"]')!.textContent).toBe("proved wrong by the real E2E");
  // Asked for by the server, so dream archives cannot crowd it out of the page.
  expect(new URL(archivedUrl, "http://x").searchParams.get("forgotten")).toBe("1");
  expect(host.textContent).not.toContain("merged by a dream");
});

test("an event's time is to the minute; its title says the day and the second", async () => {
  const el = await render();
  const times = [...el.querySelectorAll<HTMLElement>('[data-slot="memory-event-time"]')];
  expect(times.length > 0).toBe(true);
  for (const time of times) {
    expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(time.getAttribute("title")).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}:\d{2}$/);
  }
});

test("an extraction's rewrite is an Updated row with what it added; the Updated filter shows only those", async () => {
  updatedEntries = [entry({
    content: "Delete only what you made. Check shared folders first.", createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-28T09:40:00.000Z",
    metadata: { updatedByExtraction: "extract_1", previous: { content: "Delete only what you made.", updatedAt: "2026-07-20T08:00:00.000Z", replacedAt: "2026-07-28T09:30:00.000Z" } }
  })];
  const host = await render();
  // Asked for by the server, newest rewrite first, so new memories cannot crowd it out.
  expect(new URL(updatedUrl, "http://x").searchParams.get("updated")).toBe("1");
  expect(new URL(updatedUrl, "http://x").searchParams.get("status")).toBe("all");
  const verb = Array.from(host.querySelectorAll("span.font-medium")).find((v) => v.textContent === "Updated");
  expect(verb?.className.split(/\s+/)).toContain("text-blue");
  const previews = () => Array.from(host.querySelectorAll('[data-slot="memory-preview"]')).map((p) => p.textContent);
  expect(previews()).toContain("+ Check shared folders first.");
  const chip = Array.from(host.querySelectorAll("button[aria-pressed]")).find((b) => b.textContent === "Updated") as HTMLButtonElement;
  chip.click();
  await settle(5);
  expect(previews()).toEqual(["+ Check shared folders first."]);
});
