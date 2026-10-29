import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { BrowseView } from "@/routes/memory/BrowseView";
import { ActivityView } from "@/routes/memory/dream/ActivityView";
import { DEFAULT_FILTERS } from "@/routes/memory/memory-filters";
import { MemoryPage } from "@/routes/memory/MemoryPage";
import { OverviewView } from "@/routes/memory/OverviewView";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchHandler } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

afterEach(() => runCleanups());

const STATS: MemoryStatsResponse = {
  totals: { available: 10, archived: 2, total: 12 },
  byScope: { user: 2, project: 8 },
  byType: { preference: 4, knowledge: 3 },
  bySource: { user: 0, agent: 10, extraction: 0 },
  byProject: [{ projectId: "p1", name: "project-3", count: 7 }],
  projectNames: {}
};

const entry = (id: string): MemoryEntryDto => ({
  id, scope: "user", projectId: null, featureId: null, type: "knowledge", status: "available",
  content: `memory ${id}`, source: "agent", userQuote: null, sourceThreadId: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", metadata: null
});

async function mountWith(handler: FetchHandler, node: React.ReactNode) {
  mockFetch(handler);
  const { host } = await mountAsync(<MemoryRouter>{node}</MemoryRouter>);
  // The views load on a zero timer; let it fire and the responses land.
  await settle(10);
  return host;
}
const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const retryIn = (el: Element) => [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
const failure = (host: ParentNode) => host.querySelector('[data-slot="inline-error"]')!;

test("Overview's Just learned asks for what was learned: the parts a dream split off stay out, as in Activity", async () => {
  const urls: string[] = [];
  await mountWith(({ url }) => {
    urls.push(url);
    if (url.includes("/stats")) return jsonResponse(STATS);
    if (url.includes("/dream/runs")) return jsonResponse({ runs: [] });
    if (url.includes("/briefs")) return jsonResponse({ briefs: [] });
    return jsonResponse({ entries: [], total: 0 });
  }, <PaneHeaderSlotsProvider><PaneHeaderActionsSlot /><MemoryPage /></PaneHeaderSlotsProvider>);
  const learned = urls.filter((url) => url.includes("/memory/entries") && url.includes("sort=created"));
  expect(learned.length).toBe(1);
  expect(new URL(learned[0]!, "http://x").searchParams.get("learned")).toBe("1");
});

test("an Overview whose first read fails is the inline error, not a blank page; Retry reads again", async () => {
  let statsReads = 0;
  const host = await mountWith(({ url }) => {
    if (url.includes("/stats")) {
      statsReads += 1;
      return statsReads === 1 ? jsonResponse({ error: "database is locked" }, 500) : jsonResponse(STATS);
    }
    if (url.includes("/dream/runs")) return jsonResponse({ runs: [] });
    return jsonResponse({ entries: [], total: 0 });
  }, <PaneHeaderSlotsProvider><PaneHeaderActionsSlot /><MemoryPage /></PaneHeaderSlotsProvider>);
  expect(failure(host).textContent).toContain("Couldn't load memory.");
  expect(failure(host).querySelector("p")!.textContent).toBe("database is locked");
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  expect(statsReads).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("10 live");
});

test("an Overview whose refresh fails keeps its figures and says they are the last loaded ones", async () => {
  let retried = 0;
  const { host } = await mountAsync(
    <MemoryRouter>
      <OverviewView stats={STATS} justLearned={[]} lastDream={null} loading={false} running={false}
        onRunDream={() => {}} error="database is locked" onRetry={() => { retried += 1; }} />
    </MemoryRouter>
  );
  expect(failure(host).textContent).toContain("Couldn't refresh memory. Showing the last loaded figures.");
  expect(host.textContent).toContain("10 live");
  await act(async () => { retryIn(failure(host)).click(); });
  expect(retried).toBe(1);
});

test("Browse that fails to load says so alone: no count, no \"No memories match\"; Retry reads again", async () => {
  let reads = 0;
  const host = await mountWith(() => {
    reads += 1;
    return reads === 1 ? jsonResponse({ error: "database is locked" }, 500) : jsonResponse({ entries: [entry("a")], total: 1 });
  }, <BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={STATS} />);
  expect(failure(host).textContent).toContain("Couldn't load memories.");
  expect(host.textContent).not.toContain("No memories match");
  expect(host.textContent).not.toContain("0 memories");
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  expect(reads).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("memory a");
});

test("Browse loading is the Loading… line", async () => {
  const host = await mountWith(() => new Promise<Response>(() => {}), <BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={STATS} />);
  expect(host.querySelector('[data-slot="loading-line"]')!.textContent).toBe("Loading…");
});

test("Browse whose next page fails keeps the rows and says so where Load more was; Retry asks for that page", async () => {
  const offsets: string[] = [];
  const first = Array.from({ length: 50 }, (_, i) => entry(`e${i}`));
  const host = await mountWith(({ url }) => {
    const offset = new URL(url, "http://x").searchParams.get("offset") ?? "0";
    offsets.push(offset);
    return offset === "0" ? jsonResponse({ entries: first, total: 80 }) : jsonResponse({ error: "database is locked" }, 500);
  }, <BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={STATS} />);
  const more = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Load ") && b.textContent.endsWith(" more"))!;
  expect(more === undefined).toBe(false);
  await act(async () => { more.click(); });
  await settle(10);
  expect(failure(host).textContent).toContain("Couldn't load more memories.");
  expect(host.textContent).toContain("memory e0");
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  expect(offsets).toStrictEqual(["0", "50", "50"]);
});

test("Memory activity that fails to load says so alone, never \"Nothing has happened yet\"; Retry reads again", async () => {
  let fail = true;
  const host = await mountWith(({ url }) => {
    if (fail) return jsonResponse({ error: "database is locked" }, 500);
    return url.includes("/dream/runs") ? jsonResponse({ runs: [] }) : jsonResponse({ entries: [entry("a")] });
  }, <ActivityView stats={STATS} />);
  expect(failure(host).textContent).toContain("Couldn't load activity.");
  expect(failure(host).querySelector("p")!.textContent).toBe("database is locked");
  expect(host.textContent).not.toContain("Nothing has happened yet");
  fail = false;
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
});

test("Memory activity loading is the Loading… line", async () => {
  const host = await mountWith(() => new Promise<Response>(() => {}), <ActivityView stats={STATS} />);
  expect(host.querySelector('[data-slot="loading-line"]')!.textContent).toBe("Loading…");
});

/** Answers held until the test releases them, in the order asked. */
function heldFetch() {
  const held: Array<{ url: string; answer: (response: Response) => void }> = [];
  mockFetch(({ url }) => new Promise<Response>((resolve) => { held.push({ url, answer: resolve }); }));
  return held;
}

test("Browse: a next page that fails after the filters changed is not the new list's failure", async () => {
  const held = heldFetch();
  const view = await mountAsync(<MemoryRouter><BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={STATS} /></MemoryRouter>);
  await settle(10);
  await act(async () => { held[0]!.answer(jsonResponse({ entries: Array.from({ length: 50 }, (_, i) => entry(`e${i}`)), total: 80 })); });
  await settle(10);
  const more = [...view.host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Load ") && b.textContent.endsWith(" more"))!;
  await act(async () => { more.click(); });
  // The filters change while that page is on its way.
  view.rerender(<MemoryRouter><BrowseView filters={{ ...DEFAULT_FILTERS, q: "project-1" }} setFilters={() => {}} stats={STATS} /></MemoryRouter>);
  await settle(10);
  expect(held.length).toBe(3);
  // The new list lands first, then the old page's failure.
  await act(async () => { held[2]!.answer(jsonResponse({ entries: Array.from({ length: 50 }, (_, i) => entry(`f${i}`)), total: 60 })); });
  await settle(10);
  expect(view.host.textContent).toContain("memory f0");
  await act(async () => { held[1]!.answer(jsonResponse({ error: "database is locked" }, 500)); });
  await settle(10);
  expect(has(view.host, '[data-slot="inline-error"]')).toBe(false);
  expect(view.host.textContent).toContain("memory f0");
  expect(view.host.textContent).not.toContain("memory e0");
});

test("Browse: a Retry still on its way when the filters change cannot undo the new list", async () => {
  const held = heldFetch();
  const view = await mountAsync(<MemoryRouter><BrowseView filters={DEFAULT_FILTERS} setFilters={() => {}} stats={STATS} /></MemoryRouter>);
  await settle(10);
  await act(async () => { held[0]!.answer(jsonResponse({ error: "database is locked" }, 500)); });
  await settle(10);
  await act(async () => { retryIn(failure(view.host)).click(); });
  view.rerender(<MemoryRouter><BrowseView filters={{ ...DEFAULT_FILTERS, q: "project-1" }} setFilters={() => {}} stats={STATS} /></MemoryRouter>);
  await settle(10);
  expect(held.length).toBe(3);
  await act(async () => { held[2]!.answer(jsonResponse({ entries: [entry("f0")], total: 1 })); });
  await settle(10);
  await act(async () => { held[1]!.answer(jsonResponse({ error: "database is locked" }, 500)); });
  await settle(10);
  expect(has(view.host, '[data-slot="inline-error"]')).toBe(false);
  expect(view.host.textContent).toContain("memory f0");
});

test("an Overview read overtaken by a newer one cannot bring back its failure", async () => {
  // Stats reads are held; everything else answers at once. Read 1 loads the
  // page, read 2 (Refresh) fails, read 3 is Retry, read 4 follows Run now.
  const stats: Array<(response: Response) => void> = [];
  mockFetch(({ url, init }) => {
    if (url.includes("/stats")) return new Promise<Response>((resolve) => { stats.push(resolve); });
    if (url.includes("/dream/runs")) return init?.method === "POST" ? jsonResponse({ ok: true }) : jsonResponse({ runs: [] });
    return jsonResponse({ entries: [], total: 0 });
  });
  const { host } = await mountAsync(
    <MemoryRouter><PaneHeaderSlotsProvider><PaneHeaderActionsSlot /><MemoryPage /></PaneHeaderSlotsProvider></MemoryRouter>
  );
  await settle(10);
  await act(async () => { stats[0]!(jsonResponse(STATS)); });
  await settle(10);
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;
  await act(async () => { button("Refresh").click(); });
  await settle(10);
  await act(async () => { stats[1]!(jsonResponse({ error: "database is locked" }, 500)); });
  await settle(10);
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  await act(async () => { button("Run now").click(); });
  await settle(10);
  expect(stats.length).toBe(4);
  // The newest read succeeds first; the Retry it overtook fails after.
  await act(async () => { stats[3]!(jsonResponse(STATS)); });
  await settle(10);
  await act(async () => { stats[2]!(jsonResponse({ error: "database is locked" }, 500)); });
  await settle(10);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("10 live");
});

test("a Memory activity read overtaken by a newer one cannot bring back its failure", async () => {
  // Dream-run reads are held; the rest answer at once. Read 1 fails, read 2
  // is Retry, read 3 follows Run now.
  const runs: Array<(response: Response) => void> = [];
  mockFetch(({ url, init }) => {
    if (url.includes("/dream/runs")) {
      if (init?.method === "POST") return jsonResponse({ ok: true });
      return new Promise<Response>((resolve) => { runs.push(resolve); });
    }
    return jsonResponse({ entries: [entry("a")] });
  });
  const { host } = await mountAsync(<MemoryRouter><ActivityView stats={STATS} /></MemoryRouter>);
  await settle(10);
  await act(async () => { runs[0]!(jsonResponse({ error: "database is locked" }, 500)); });
  await settle(10);
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  const runNow = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Run now"))!;
  await act(async () => { runNow.click(); });
  await settle(10);
  expect(runs.length).toBe(3);
  await act(async () => { runs[2]!(jsonResponse({ runs: [] })); });
  await settle(10);
  await act(async () => { runs[1]!(jsonResponse({ error: "database is locked" }, 500)); });
  await settle(10);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("memory a");
});
