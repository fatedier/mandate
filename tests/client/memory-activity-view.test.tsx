import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { MemoryDreamRunDto, MemoryEntryDto } from "@shared/api-contracts";
import { ActivityView } from "@/routes/memory/dream/ActivityView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    scope: "global",
    projectId: null,
    featureId: null,
    kind: "semantic",
    status: "available",
    content: "something",
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
    phase: "global",
    projectId: null,
    projectName: null,
    candidateCount: 3,
    appliedCount: 1,
    actionCount: 3,
    actionCounts: { keep: 2, update: 1, merge: 0, archive: 0, rescope: 0 },
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

/** One learned entry, nothing archived, one finished dream of one run. */
function bodyFor(url: string): unknown {
  if (url.includes("/dream/runs")) {
    return { runs: [run("2026-07-28T08:00:00.000Z", "2026-07-28T08:02:00.000Z")] };
  }
  if (url.includes("status=archived")) return { entries: [] };
  if (url.includes("status=all")) return { entries: [entry()] };
  // No silent `{ ok: true }`: a request this stub does not know is a request
  // the view makes that the test never modelled.
  throw new Error("unmocked fetch: " + url);
}

let originalFetch: typeof globalThis.fetch | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
});

async function render(): Promise<HTMLElement> {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(new Response(JSON.stringify(bodyFor(String(input)))))) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ActivityView />
      </MemoryRouter>
    );
  });
  // The view loads on a zero timer; let it fire and the responses land.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  return container;
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
