import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { MemoryBriefDto, MemoryDreamRunDto, MemoryEntryDto, MemoryEntryHistoryResponse, MemoryStatsResponse } from "@shared/api-contracts";
import { BriefsSection } from "@/routes/memory/BriefsSection";
import { useRunDialog } from "@/routes/memory/dream/use-run-dialog";
import { DreamRunDialog } from "@/routes/memory/dream/DreamRunDialog";
import { MemoryDetailDialog } from "@/routes/memory/MemoryEntryDetail";
import { MemoryPane } from "@/routes/settings/MemoryPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

/** The Memory page. */

const STATS: MemoryStatsResponse = {
  totals: { available: 12, archived: 3, total: 15 },
  byScope: { user: 5, project: 7 },
  byType: { preference: 4, knowledge: 7 },
  bySource: { user: 2, agent: 3, extraction: 7 },
  byProject: [{ projectId: "proj_project-1", name: "project-1", count: 7 }],
  projectNames: { "proj_project-1": "project-1" }
};

function brief(over: Partial<MemoryBriefDto> = {}): MemoryBriefDto {
  return {
    scope: "user", projectId: null, projectName: null,
    content: "Writes the billing service.\n### Working rules\n- Ask before a **migration**.",
    builtAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), stale: false, tokens: 412, tokenLimit: 2000,
    ...over
  };
}

async function briefs(list: MemoryBriefDto[]) {
  const { host } = await mountAsync(
    <MemoryRouter>
      <BriefsSection briefs={list} stats={STATS} />
    </MemoryRouter>
  );
  return host;
}

test("the user's brief comes first and none opens until asked; one opens to its body rendered and its size; a closed brief shows its first line", async () => {
  const host = await briefs([
    brief(),
    brief({ scope: "project", projectId: "proj_project-1", projectName: "project-1", content: "project-1: an admin panel.\n- Deploys on Tuesdays.", tokens: 120, tokenLimit: 1500 })
  ]);
  const rows = Array.from(host.querySelectorAll('[data-slot="brief"]'));
  const heads = () => rows.map((row) => row.querySelector("button")!.textContent);
  // Closed, each shows its first line.
  expect(heads()).toEqual([
    "YouWrites the billing service.5 memories · built 3d ago",
    "project-1project-1: an admin panel.7 memories · built 3d ago"
  ]);
  expect(rows.map((row) => row.querySelector("button")!.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  expect(host.querySelector('[data-slot="brief-body"]') === null).toBe(true);

  await act(async () => { (rows[0]!.querySelector("button") as HTMLButtonElement).click(); });
  // An open brief's first line is the body's first line: the header shows it
  // only while the body is closed.
  expect(heads()).toEqual([
    "You5 memories · built 3d ago",
    "project-1project-1: an admin panel.7 memories · built 3d ago"
  ]);
  expect(rows[0]!.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  const body = rows[0]!.querySelector('[data-slot="brief-body"]')!;
  expect(body.querySelector("strong")!.textContent).toBe("migration");
  // The whole brief, as agents read it: its first line too.
  expect(body.textContent).toContain("Writes the billing service.");
  expect(rows[0]!.textContent).toContain("412 of 2,000 tokens");
  const link = rows[0]!.querySelector("a") as HTMLAnchorElement;
  expect(link.textContent).toBe("See its 5 memories");
  expect(new URL(link.href, "http://x").searchParams.get("scope")).toBe("user");

  await act(async () => { (rows[1]!.querySelector("button") as HTMLButtonElement).click(); });
  expect(rows[0]!.querySelector('[data-slot="brief-body"]') === null).toBe(true);
  expect(heads()).toEqual([
    "YouWrites the billing service.5 memories · built 3d ago",
    "project-17 memories · built 3d ago"
  ]);
  const projectLink = rows[1]!.querySelector("a") as HTMLAnchorElement;
  expect(new URL(projectLink.href, "http://x").searchParams.get("project")).toBe("proj_project-1");
});

test("a one-line brief opens to that line", async () => {
  const host = await briefs([brief({ content: "Only this line." })]);
  await act(async () => { (host.querySelector('[data-slot="brief"] button') as HTMLButtonElement).click(); });
  expect(host.querySelector('[data-slot="brief-body"]')!.textContent).toContain("Only this line.");
});

test("a brief whose memories changed says the next dream will rewrite it; with none, the section says when they come", async () => {
  const stale = await briefs([brief({ stale: true })]);
  expect(stale.textContent).toContain("changes waiting for the next dream");
  const empty = await briefs([]);
  expect(empty.textContent).toContain("No briefs yet. The dream writes them after its first run.");
});

const ENTRY: MemoryEntryDto = {
  id: "mem_abcdefghijkl", scope: "project", projectId: "proj_project-1", featureId: null, type: "preference",
  source: "user", userQuote: "deploy on Tuesday, then post the notes", status: "available",
  content: "project-1 deploys on Tuesdays, then posts the notes.", sourceThreadId: "thr_w",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z", metadata: null
};

const HISTORY: MemoryEntryHistoryResponse = {
  events: [
    { at: "2026-10-06T00:00:00.000Z", text: "The dream merged mem_12345678 into this", detail: "same rule" },
    { at: "2026-10-01T00:00:00.000Z", text: "Remembered from your words" }
  ],
  sourceThread: { id: "thr_w", scope: "worker", title: null, projectSlug: "md-project-1", featureSlug: "release", featureName: "release", archived: false }
};

test("a memory's detail shows the user's words, the conversation it came from, and its history", async () => {
  const seen: string[] = [];
  mockFetch((call) => { seen.push(call.url); return jsonResponse(HISTORY); });
  const { host } = await mountAsync(
    <MemoryRouter>
      <MemoryDetailDialog entry={ENTRY} open onOpenChange={() => {}} resolveProject={(id) => (id === "proj_project-1" ? "project-1" : undefined)} />
    </MemoryRouter>
  );
  await settle(10);
  const dialog = document.body;
  expect(seen).toStrictEqual(["/api/memory/entries/mem_abcdefghijkl/history"]);
  expect(dialog.textContent).toContain("“deploy on Tuesday, then post the notes”");
  expect(dialog.textContent).toContain("project-1");
  const from = Array.from(dialog.querySelectorAll("a")).find((a) => a.textContent === "release (worker)") as HTMLAnchorElement;
  expect(new URL(from.href, "http://x").pathname).toBe("/projects/md-project-1/features/release");
  // A link on a line of its own: 44px to tap on a touch screen.
  expect(from.className.split(/\s+/)).toContain("hit");
  const history = Array.from(dialog.querySelectorAll('[data-slot="memory-history"] li')).map((li) => li.textContent);
  expect(history[0]).toContain("The dream merged mem_12345678 into thissame rule");
  expect(history[1]).toContain("Remembered from your words");
  // The header's stamps and each event: the exact time on hover, as every
  // other title writes it.
  for (const stamp of dialog.querySelectorAll('[data-slot="memory-stamp"]')) {
    expect(stamp.getAttribute("title")).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}:\d{2}$/);
  }
  expect(dialog.querySelectorAll('[data-slot="memory-stamp"]').length > 0).toBe(true);
  for (const when of dialog.querySelectorAll('[data-slot="memory-history"] li > span:first-child')) {
    expect(when.getAttribute("title")).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}:\d{2}$/);
  }
  void host;
});

// The version a change of the text replaced is kept, one back: the detail
// shows it when its time was kept (one kept before may be older than the last).
test("a memory's detail shows the version before its last update, when that is known", async () => {
  mockFetch(() => jsonResponse(HISTORY));
  const previous = { content: "project-1 deploys on Tuesdays.", updatedAt: "2026-10-01T00:00:00.000Z" };
  const { host } = await mountAsync(
    <MemoryRouter>
      <MemoryDetailDialog entry={{ ...ENTRY, metadata: { previous: { ...previous, replacedAt: "2026-10-06T00:00:00.000Z" } } }} open onOpenChange={() => {}} />
    </MemoryRouter>
  );
  await settle(10);
  const before = document.body.querySelector('[data-slot="memory-before-update"]');
  expect(before?.textContent).toBe("project-1 deploys on Tuesdays.");
  expect(document.body.textContent).toContain("before the last update");
  void host;
});

test("a memory's detail leaves out a version kept before its time was", async () => {
  mockFetch(() => jsonResponse(HISTORY));
  const { host } = await mountAsync(
    <MemoryRouter>
      <MemoryDetailDialog entry={{ ...ENTRY, metadata: { previous: { content: "project-1 deploys on Tuesdays.", updatedAt: "2026-10-01T00:00:00.000Z" } } }} open onOpenChange={() => {}} />
    </MemoryRouter>
  );
  await settle(10);
  expect(document.body.querySelector('[data-slot="memory-history"]')).not.toBeNull();
  expect(document.body.querySelector('[data-slot="memory-before-update"]')).toBeNull();
  void host;
});

// The detail's header says what its Browse row says, the same way: type,
// where it lives, archived (the header had an uppercase PROJECT
// chip, struck through when archived, beside a row reading "task · project-1").
test("a memory's detail header is its Browse row's line: type, where it lives, archived", async () => {
  mockFetch(() => jsonResponse(HISTORY));
  await mountAsync(
    <MemoryRouter>
      <MemoryDetailDialog entry={{ ...ENTRY, status: "archived" }} open onOpenChange={() => {}} resolveProject={(id) => (id === "proj_project-1" ? "project-1" : undefined)} />
    </MemoryRouter>
  );
  await settle(10);
  const title = document.body.querySelector('[data-slot="dialog-title"]') ?? document.body.querySelector("h2")!;
  const line = title.querySelector('[data-slot="memory-entry-line"]')!;
  expect(line === null).toBe(false);
  expect(line.textContent).toBe("preferenceproject-1archived");
  // No box of its own: its parts sit in the header's (and a Browse row's) own flex line.
  expect(line.className.split(/\s+/)).toContain("contents");
  expect(title.querySelector(".label-micro") === null).toBe(true);
});

// A source whose page no longer opens is named in plain text, without a link.
const unlinkedRows: Array<{ name: string; sourceThread: MemoryEntryHistoryResponse["sourceThread"]; says: string }> = [
  {
    name: "the source of a memory from an archived conversation is named, not linked: its page no longer opens",
    sourceThread: { id: "thr_m", scope: "manager", title: "Release planning", projectSlug: null, featureSlug: null, featureName: null, archived: true },
    says: "Release planning (archived)"
  }
];

test.each(unlinkedRows)("$name", async ({ sourceThread, says }) => {
  mockFetch(() => jsonResponse({ ...HISTORY, sourceThread } satisfies MemoryEntryHistoryResponse));
  await mountAsync(
    <MemoryRouter>
      <MemoryDetailDialog entry={ENTRY} open onOpenChange={() => {}} />
    </MemoryRouter>
  );
  await settle(10);
  const from = document.body.querySelector('[data-slot="memory-source"]')!;
  expect(from.textContent).toBe(says);
  // Neither a link itself nor inside one.
  expect(from.closest("a") === null).toBe(true);
});

function runDto(id: string, projectName: string): MemoryDreamRunDto {
  return {
    id, trigger: "manual", status: "succeeded", provider: "openai", model: "m", phase: "project",
    projectId: `p_${projectName}`, projectName, candidateCount: 0, appliedCount: 0, actionCount: 0,
    actionCounts: { update: 0, merge: 0, archive: 0, move: 0, split: 0 },
    rejectedCount: 0, failedCount: 0, finishReason: null, error: null, metadata: null,
    startedAt: "2026-10-07T00:00:00.000Z", finishedAt: "2026-10-07T00:01:00.000Z",
    availableCountBefore: 0, availableCountAfter: 0
  };
}

function RunPicker({ runs }: { runs: MemoryDreamRunDto[] }) {
  const { openRun, dialog, error } = useRunDialog();
  return (
    <>
      {runs.map((run) => <button key={run.id} type="button" data-run={run.id} onClick={() => void openRun(run)}>{run.id}</button>)}
      <p data-slot="run-error">{error}</p>
      {dialog}
    </>
  );
}

test("a run's dialog shows the run picked last, whichever answer lands last", async () => {
  const answers: Array<(response: Response) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => answers.push(resolve)));
  const alpha = runDto("drm_alpha", "alpha");
  const beta = runDto("drm_beta", "beta");
  const { host } = await mountAsync(<MemoryRouter><RunPicker runs={[alpha, beta]} /></MemoryRouter>);
  const pick = (id: string) => (host.querySelector(`[data-run="${id}"]`) as HTMLButtonElement).click();

  await act(async () => { pick("drm_alpha"); pick("drm_beta"); });
  await act(async () => { answers[1]!(jsonResponse({ run: beta, actions: [], brief: null })); });
  await settle(5);
  await act(async () => { answers[0]!(jsonResponse({ run: alpha, actions: [], brief: null })); });
  await settle(5);
  expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain("beta");
  expect(document.body.querySelector('[role="dialog"]')!.textContent).not.toContain("alpha");

  // An earlier pick that fails after a later one opened says nothing.
  await act(async () => { pick("drm_alpha"); pick("drm_beta"); });
  await act(async () => { answers[3]!(jsonResponse({ run: beta, actions: [], brief: null })); });
  await settle(5);
  await act(async () => { answers[2]!(jsonResponse({ error: "boom" }, 500)); });
  await settle(5);
  expect(host.querySelector('[data-slot="run-error"]')!.textContent).toBe("");
});

test("a split's card shows what it became: each part's text and id", async () => {
  const run = runDto("drm_split", "project-1");
  const split = {
    id: "dma_1", runId: run.id, actionType: "split", status: "applied", memoryId: "mem_wholewhole", targetMemoryId: null,
    reason: "two rules", confidence: null, error: null, createdAt: run.startedAt, appliedAt: run.startedAt,
    source: { parts: ["Short replies.", "Tag releases from main."] },
    before: { content: "Short replies; tag releases from main." },
    after: { content: "Short replies; tag releases from main.", status: "archived", metadata: { splitInto: ["mem_partone01", "mem_parttwo02"] } }
  } as const;
  await mountAsync(
    <MemoryRouter>
      <DreamRunDialog open onOpenChange={() => {}} run={run} actions={[split as unknown as Parameters<typeof DreamRunDialog>[0]["actions"][number]]} />
    </MemoryRouter>
  );
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Short replies.");
  expect(dialog.textContent).toContain("Tag releases from main.");
  expect(dialog.textContent).toContain("part 1 · mem_part");
  expect(dialog.textContent).toContain("part 2 · mem_part");
});

test("only a merge points to another memory: an update recorded with a target shows no arrow", async () => {
  const run = runDto("drm_arrow", "project-1");
  const base = { runId: run.id, status: "applied", confidence: null, error: null, source: null, createdAt: run.startedAt, appliedAt: run.startedAt };
  const actions = [
    // An earlier version recorded whatever the model put there.
    { ...base, id: "dma_u", actionType: "update", memoryId: "mem_updatedone", targetMemoryId: "9ab", reason: "clearer", before: { content: "old" }, after: { content: "new" } },
    { ...base, id: "dma_m", actionType: "merge", memoryId: "mem_mergedaway", targetMemoryId: "mem_keptkeptk", reason: "same", before: { content: "dup" }, after: { content: "dup", status: "archived" } }
  ];
  await mountAsync(
    <MemoryRouter>
      <DreamRunDialog open onOpenChange={() => {}} run={run} actions={actions as unknown as Parameters<typeof DreamRunDialog>[0]["actions"]} />
    </MemoryRouter>
  );
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).not.toContain("9ab");
  expect(dialog.textContent).toContain("merged into mem_kept");
  expect([...dialog.querySelectorAll('span[title="mem_keptkeptk"]')].length).toBe(1);
});

test("a run's dialog heads its list of changed memories in sentence case, like every list group", async () => {
  const run = runDto("drm_groups", "project-1");
  const base = { runId: run.id, status: "applied", targetMemoryId: null, error: null, source: null, createdAt: run.startedAt, appliedAt: run.startedAt };
  const actions = [
    { ...base, id: "dma_u", actionType: "update", memoryId: "mem_updatedone", reason: "clearer", before: { content: "old" }, after: { content: "new" } }
  ];
  await mountAsync(
    <MemoryRouter>
      <DreamRunDialog open onOpenChange={() => {}} run={run} actions={actions as unknown as Parameters<typeof DreamRunDialog>[0]["actions"]} />
    </MemoryRouter>
  );
  const dialog = document.body.querySelector('[role="dialog"]')!;
  const changed = [...dialog.querySelectorAll("h3")].find((h) => h.textContent?.startsWith("Changed"))!;
  expect(changed.className.split(/\s+/)).toContain("label-group");
});

test("a memory learned in the agent's own conversation says so with the name the app uses for it", async () => {
  mockFetch(() => jsonResponse({ ...HISTORY, sourceThread: { id: "thr_g", scope: "global", title: null, projectSlug: null, featureSlug: null, featureName: null, archived: false } }));
  await mountAsync(
    <MemoryRouter>
      <MemoryDetailDialog entry={ENTRY} open onOpenChange={() => {}} resolveProject={() => "project-1"} />
    </MemoryRouter>
  );
  await settle(10);
  const from = Array.from(document.body.querySelectorAll("a")).find((a) => new URL(a.href, "http://x").pathname === "/agent");
  expect(from?.textContent).toBe("Your agent");
});

test("Settings › Memory sends View history to the activity view", async () => {
  mockFetch(() => jsonResponse({
    ok: true, restartRequired: false,
    memory: { embedding: { model: "" }, dream: { enabled: true } },
    models: { providers: {} }
  } as unknown as SettingsConfigResponse));
  const { host } = await mountAsync(
    <MemoryRouter>
      <SettingsConfigProvider>
        <MemoryPane />
      </SettingsConfigProvider>
    </MemoryRouter>
  );
  await settle(10);
  const link = Array.from(host.querySelectorAll("a")).find((a) => a.textContent?.includes("View history")) as HTMLAnchorElement;
  expect(new URL(link.href, "http://x").pathname + new URL(link.href, "http://x").search).toBe("/memory?view=activity");
});

test("Settings › Memory with no embedding model says what that means, in the body face", async () => {
  mockFetch(() => jsonResponse({
    ok: true, restartRequired: false,
    memory: { embedding: { model: "" }, dream: { enabled: true } },
    models: { providers: { "team-proxy": { type: "openai-compatible", models: [{ id: "text-embedding-3-small" }] } } }
  } as unknown as SettingsConfigResponse));
  const { host } = await mountAsync(
    <MemoryRouter>
      <SettingsConfigProvider>
        <MemoryPane />
      </SettingsConfigProvider>
    </MemoryRouter>
  );
  await settle(10);
  const trigger = host.querySelector<HTMLElement>('[data-slot="select-trigger"][aria-label="Embedding model"]')!;
  // Without one, recall matches words only (the server searches its full-text
  // index alone).
  expect(trigger.textContent).toBe("None — recall by words only");
  // Model ids are mono; the sentence is not one.
  expect(trigger.className.split(/\s+/)).toContain("data-[placeholder]:font-sans");
});
