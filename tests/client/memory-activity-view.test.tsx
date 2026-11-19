import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { MemoryDreamRunDto, MemoryEntryDto, MemoryStatsResponse, SkillReviewRunDto, SkillTidyRunDto } from "@shared/api-contracts";
import { ActivityView } from "@/routes/memory/dream/ActivityView";
import { runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { memoryEntry } from "../helpers/client-builders.js";

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
    appliedCount: 1,
    actionCount: 3,
    actionCounts: { update: 1, merge: 0, archive: 0, move: 0, split: 0 },
    rejectedCount: 0,
    finishReason: null,
    error: null,
    metadata: null,
    startedAt,
    finishedAt,
    availableCountBefore: 0,
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
/** The requested skill reviews; a test may add some, or make the read fail. */
let reviewRuns: SkillReviewRunDto[] = [];
/** The tidies of all skills, read with the reviews. */
let tidyRuns: SkillTidyRunDto[] = [];
let reviewsFail = false;
/** The memories and dreams: a test may make them empty, or their read fail. */
let feedEmpty = false;
let feedFail = false;

/** One learned entry, nothing archived, one finished dream of one run. */
function bodyFor(url: string): unknown {
  if (!url.includes("/api/skills/reviews")) {
    if (feedFail) throw new Error("feed unavailable");
    if (feedEmpty) return url.includes("/dream/runs") ? { runs: [] } : { entries: [] };
  }
  if (url.includes("/api/skills/reviews")) {
    if (reviewsFail) throw new Error("reviews unavailable");
    return { runs: reviewRuns, tidies: tidyRuns };
  }
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
  if (url.includes("status=all&learned=1")) return { entries: [memoryEntry(learned)] };
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
  reviewRuns = [];
  tidyRuns = [];
  reviewsFail = false;
  feedEmpty = false;
  feedFail = false;
});

async function render(stats: MemoryStatsResponse | null = null): Promise<HTMLElement> {
  mockFetch(({ url }) => {
    try {
      return new Response(JSON.stringify(bodyFor(url)));
    } catch (error) {
      if (url.includes("/api/skills/reviews") || feedFail) return new Response("busy", { status: 503 });
      throw error;
    }
  });
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
    memoryEntry({ status: "archived", content: "the bridge fixes the leak", updatedAt: "2026-07-28T09:00:00.000Z", metadata: { forgottenReason: "proved wrong by the real E2E" } }),
    memoryEntry({ status: "archived", content: "merged by a dream", updatedAt: "2026-07-28T09:30:00.000Z", metadata: { mergedInto: "mem_x" } })
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
  updatedEntries = [memoryEntry({
    content: "Delete only what you made. Check shared folders first.", createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-28T09:40:00.000Z",
    metadata: { updatedByExtraction: "extract_1", previous: { content: "Delete only what you made.", updatedAt: "2026-07-20T08:00:00.000Z", replacedAt: "2026-07-28T09:30:00.000Z" } }
  })];
  const host = await render();
  // Asked for by the server, newest rewrite first, so new memories cannot crowd it out.
  expect(new URL(updatedUrl, "http://x").searchParams.get("updated")).toBe("1");
  expect(new URL(updatedUrl, "http://x").searchParams.get("status")).toBe("all");
  const verb = Array.from(host.querySelectorAll("span.font-medium")).find((v) => v.textContent === "Updated");
  expect(verb?.className.split(/\s+/)).toContain("text-phase-working");
  const previews = () => Array.from(host.querySelectorAll('[data-slot="memory-preview"]')).map((p) => p.textContent);
  expect(previews()).toContain("+ Check shared folders first.");
  const chip = Array.from(host.querySelectorAll("button[aria-pressed]")).find((b) => b.textContent === "Updated") as HTMLButtonElement;
  chip.click();
  await settle(5);
  expect(previews()).toEqual(["+ Check shared folders first."]);
});

function review(over: Partial<SkillReviewRunDto>): SkillReviewRunDto {
  return {
    id: `skr_${++seq}`, threadId: "thr_w", threadTitle: "cert renewal", threadKind: "worker", status: "succeeded", outcome: "none",
    skillId: null, skillName: null, revision: null, reason: null, error: null,
    createdAt: "2026-07-28T09:00:00.000Z", startedAt: "2026-07-28T09:00:01.000Z", finishedAt: "2026-07-28T09:02:00.000Z",
    ...over
  };
}

test("Activity lists a review with its state", async () => {
  reviewRuns = [
    review({ status: "running", outcome: null, finishedAt: null, startedAt: "2026-07-28T09:30:00.000Z" }),
    review({ outcome: "created", skillId: "skl_cert", skillName: "cert-renewal", revision: 1, reason: "Kept the renewal order.", startedAt: "2026-07-28T09:20:00.000Z" }),
    review({ outcome: "changed", skillId: "skl_rel", skillName: "release-steps", revision: 4, threadTitle: "Releases", threadKind: "manager", startedAt: "2026-07-28T09:15:00.000Z" }),
    review({ outcome: "restored", skillId: "skl_old", skillName: "old-steps", revision: 3, startedAt: "2026-07-28T09:12:00.000Z" }),
    review({ outcome: "none", reason: "A one-off.", startedAt: "2026-07-28T09:10:00.000Z" }),
    review({ status: "failed", outcome: null, error: "The review used its 40 steps without finishing.", startedAt: "2026-07-28T09:05:00.000Z" }),
    // Not begun yet: not in the feed.
    review({ status: "queued", outcome: null, startedAt: null, finishedAt: null, threadTitle: "Waiting one" })
  ];
  const el = await render();
  const rows = [...el.querySelectorAll<HTMLElement>('[data-slot="review-event"]')].map((r) => r.querySelector('[data-slot="review-state"]')?.textContent ?? "");
  expect(rows).toEqual(["Running", "Wrote cert-renewal", "Changed release-steps", "Restored old-steps", "Nothing to change", "Failed"]);
  const heads = [...el.querySelectorAll<HTMLElement>('[data-slot="review-event"] [data-slot="review-title"]')].map((r) => r.textContent);
  expect(heads[2]).toBe("Skill review of Releases");
  expect(heads.every((h) => h !== "Skill review of Waiting one")).toBe(true);
  expect(el.textContent).toContain("Kept the renewal order.");
  expect(el.textContent).toContain("The review used its 40 steps without finishing.");
  // A written skill links to its History at the revision the review wrote.
  const links = [...el.querySelectorAll<HTMLAnchorElement>('[data-slot="review-event"] a')].map((a) => a.getAttribute("href"));
  expect(links).toContain("/memory?view=skills&skill=skl_cert&revision=1");
});

function tidy(over: Partial<SkillTidyRunDto>): SkillTidyRunDto {
  return {
    id: `skt_${++seq}`, status: "succeeded", reason: null, error: null, changed: [],
    createdAt: "2026-07-28T09:00:00.000Z", startedAt: "2026-07-28T09:00:00.000Z", finishedAt: "2026-07-28T09:03:00.000Z",
    ...over
  };
}

test("Activity shows a skill tidy as 'Skill tidy', a 'Changed {name}' link per change to its revision, and its reason", async () => {
  tidyRuns = [
    tidy({ status: "running", finishedAt: null, startedAt: "2026-07-28T09:40:00.000Z" }),
    tidy({
      reason: "Merged the two order skills.", startedAt: "2026-07-28T09:35:00.000Z",
      changed: [{ skillId: "skl_named", skillName: "named-order-intake", revision: 4 }, { skillId: "skl_nightly", skillName: "nightly-order-intake", revision: 2 }]
    }),
    tidy({ reason: "Nothing needed to change.", startedAt: "2026-07-28T09:30:00.000Z" }),
    tidy({ status: "failed", error: "The review used its 50 steps without finishing.", startedAt: "2026-07-28T09:25:00.000Z" })
  ];
  const el = await render();
  const rows = [...el.querySelectorAll<HTMLElement>('[data-slot="tidy-event"]')];
  expect(rows.map((r) => r.querySelector('[data-slot="review-title"]')?.textContent)).toEqual(["Skill tidy", "Skill tidy", "Skill tidy", "Skill tidy"]);
  expect(rows.map((r) => [...r.querySelectorAll('[data-slot="review-state"]')].map((s) => s.textContent))).toEqual([
    ["Running"], ["Changed named-order-intake", "Changed nightly-order-intake"], ["Nothing to change"], ["Failed"]
  ]);
  expect([...rows[1]!.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
    "/memory?view=skills&skill=skl_named&revision=4", "/memory?view=skills&skill=skl_nightly&revision=2"
  ]);
  expect(el.textContent).toContain("Merged the two order skills.");
  expect(el.textContent).toContain("The review used its 50 steps without finishing.");
});

test("when the reviews cannot be read, the rest of the feed still shows and says so", async () => {
  reviewsFail = true;
  const el = await render();
  expect(el.textContent).toContain("Learned");
  expect(el.textContent).toContain("Dream");
  expect(el.textContent).toContain("Couldn't load skill reviews.");
  expect(el.querySelectorAll('[data-slot="review-event"]').length).toBe(0);
});

test("a review's long conversation title and skill name may wrap", async () => {
  reviewRuns = [review({ outcome: "created", skillId: "skl_x", skillName: `x-${"y".repeat(80)}`, revision: 1, threadTitle: "z".repeat(90) })];
  const el = await render();
  const title = el.querySelector<HTMLElement>('[data-slot="review-title"]')!;
  const state = el.querySelector<HTMLElement>('[data-slot="review-state"]')!;
  for (const node of [title, state]) expect(["min-w-0", "[overflow-wrap:anywhere]"].every((c) => node.classList.contains(c))).toBe(true);
});

test("a feed error and a reviews error show together", async () => {
  reviewsFail = true;
  const el = await render();
  expect(el.textContent).toContain("Couldn't load skill reviews.");
  feedFail = true;
  const retry = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!;
  await act(async () => { retry.click(); });
  await settle(20);
  expect(el.textContent).toContain("Couldn't refresh activity.");
  expect(el.textContent).toContain("Couldn't load skill reviews.");
});

test("with nothing else to show and the reviews unread, the feed does not say nothing happened", async () => {
  feedEmpty = true;
  reviewsFail = true;
  const el = await render();
  expect(el.textContent).toContain("Couldn't load skill reviews.");
  expect(el.textContent?.includes("Nothing has happened yet.")).toBe(false);
});

test("a reviews read that succeeds on Retry clears its error, even while the feed fails", async () => {
  reviewsFail = true;
  reviewRuns = [review({ outcome: "none", reason: "A one-off." })];
  const el = await render();
  expect(el.textContent).toContain("Couldn't load skill reviews.");
  reviewsFail = false;
  feedFail = true;
  const retry = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!;
  await act(async () => { retry.click(); });
  await settle(20);
  expect(el.textContent?.includes("Couldn't load skill reviews.")).toBe(false);
  expect(el.querySelectorAll('[data-slot="review-event"]').length).toBe(1);
  expect(el.textContent).toContain("Couldn't refresh activity.");
});
