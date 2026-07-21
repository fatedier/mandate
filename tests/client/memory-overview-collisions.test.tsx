import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { MemoryStatsResponse } from "@shared/api-contracts";
import { OverviewView } from "@/routes/memory/OverviewView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The name-collision notice, which had no test and said "2 … both" whatever
 * the real number was.
 *
 * happy-dom performs no layout, so nothing here reads a box: the assertions are
 * the badge's text, the sentence, and where the links point.
 */

function stats(byProject: MemoryStatsResponse["byProject"]): MemoryStatsResponse {
  return {
    totals: { available: 10, archived: 2, total: 12 },
    byScope: { user: 1, global: 1, project: 6, feature: 2 },
    byKind: { episodic: 3, semantic: 3, preference: 2, procedural: 2 },
    byProject,
    usage: { used: 4, idle: 3, untouched: 3 }
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(data: MemoryStatsResponse): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <OverviewView
          stats={data}
          topRecalled={[]}
          justLearned={[]}
          lastDream={null}
          loading={false}
          onRunDream={() => {}}
          running={false}
        />
      </MemoryRouter>
    );
  });
  return container;
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
  const page = await render(stats([
    { projectId: "p1", name: "golib", count: 7 },
    { projectId: "p2", name: "golib", count: 3 },
    { projectId: "p3", name: "golib", count: 1 }
  ]));
  const row = collisionRow(page)!;
  expect(row).toBeTruthy();
  // The badge is the sentence's first word, so it is asserted as text next to
  // the words that complete it rather than as a number on its own.
  expect(row.textContent).toContain("3projects share the name golib");
});

test("each colliding project gets its own way in, filtered to that project", async () => {
  // The other half of the old bug: one link, to Browse filtered to every
  // project-scoped memory, where each row prints the project *name* — so the
  // two arrived indistinguishable, which is what the reader clicked to resolve.
  const page = await render(stats([
    { projectId: "p1", name: "golib", count: 7 },
    { projectId: "p2", name: "golib", count: 3 }
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
  const page = await render(stats([
    { projectId: "p1", name: "golib", count: 1 },
    { projectId: "p2", name: "golib", count: 4 }
  ]));
  expect([...collisionRow(page)!.querySelectorAll("a")].map((a) => a.textContent))
    .toEqual(["1 memory", "4 memories"]);
});

test("distinct names raise nothing", async () => {
  const page = await render(stats([
    { projectId: "p1", name: "golib", count: 7 },
    { projectId: "p2", name: "mandate", count: 3 }
  ]));
  expect(collisionRow(page)).toBeUndefined();
});
