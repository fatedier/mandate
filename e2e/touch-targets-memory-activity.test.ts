import { afterAll, beforeAll, test } from "bun:test";
import type { Page } from "playwright";
import type { RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness, onPhone, onDevice, expectFit, NARROW } from "./helpers/touch-targets";

// Touch targets: Memory and Activity. The rule and the measurement
// are in helpers/touch-targets.ts.
let server: RunningServer;
beforeAll(async () => {
  const harness = await startTouchHarness({ server: true });
  server = harness.server!;
}, 60_000);
afterAll(stopTouchHarness);

const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
// A finished dream: Overview's Last dream row then carries its link.
const memoryAt = (content: string) => ({ content, type: "knowledge", scope: "project" });
const dreamAction = (id: string, actionType: string, before: string, after: string | null) => ({
  id, runId: "run1", actionType, status: "applied", memoryId: `mem_${id}`, targetMemoryId: null,
  reason: "Release notes now say the race detector gates every tag from main, which the old memory left out. ".repeat(3),
  source: null, error: null, before: memoryAt(before), after: after === null ? null : memoryAt(after),
  createdAt: new Date().toISOString(), appliedAt: new Date().toISOString()
});
// One rewrite (a previous version, clamped reasons) and two archived.
const dreamActions = [
  dreamAction("a1", "update", "project-1 releases are tagged from main.", "project-1 releases are tagged from main after the full test suite passes on every platform."),
  dreamAction("a2", "archive", "The fork ships its own release notes.", null),
  dreamAction("a3", "archive", "Stream.Close must be idempotent.", null)
];
const dreamRun = {
  id: "run1", trigger: "manual", status: "succeeded", provider: "stub", model: "stub", phase: "user",
  projectId: null, projectName: null, candidateCount: 3, appliedCount: 1, actionCount: 1,
  actionCounts: { update: 0, merge: 0, archive: 1, move: 0, split: 0 }, rejectedCount: 0, failedCount: 0,
  finishReason: null, error: null, metadata: null, startedAt: at(30), finishedAt: at(29),
  availableCountBefore: 9, availableCountAfter: 8
};

// The briefs: the user's open with a body of rules, a project's closed.
const briefs = [
  { scope: "user", projectId: null, projectName: null, builtAt: at(60), stale: false, tokens: 412, tokenLimit: 2000,
    content: "Writes the billing service; project-1 releases are tagged from main.\n### Working rules\n- Run the linter before every commit.\n- Keep functions short." },
  { scope: "project", projectId: "proj_project1", projectName: "project-1", builtAt: at(60), stale: true, tokens: 120, tokenLimit: 1500,
    content: "project-1: a small admin panel.\n- Releases are cut from main." }
];

test("Memory: overview, activity, browse, a last dream, and a 320px phone", async () => {
  for (const view of ["?view=activity", "?view=browse"]) {
    expectFit(`memory${view}`, await onPhone(`${server.baseUrl}/memory${view}`, "text=project-1 releases are tagged"));
  }
  // The overview with a last dream: the overview with nothing run draws the
  // same controls, and a line of text where this draws the dream's row.
  expectFit("memory, a last dream", await onPhone(`${server.baseUrl}/memory`, "text=project-1 releases are tagged", undefined, async (page) => {
    await page.route("**/api/memory/dream/runs?**", (route) => route.fulfill({ json: { runs: [dreamRun] } }));
  }));
  // The briefs: rows that open, the open one's link to its memories.
  for (const [name, device] of [["phone", null], ["320", NARROW]] as const) {
    const ready = '[data-slot="brief"] button';
    const routeBriefs = async (page: Page) => {
      await page.route("**/api/memory/briefs", (route) => route.fulfill({ json: { briefs } }));
    };
    // None starts open: the user's is opened by a tap.
    const openFirst = async (page: Page) => {
      await page.locator(ready).first().tap();
      await page.locator('[data-slot="brief-body"]').waitFor();
    };
    expectFit(`memory, briefs (${name})`, device
      ? await onDevice(device, `${server.baseUrl}/memory`, ready, openFirst, routeBriefs)
      : await onPhone(`${server.baseUrl}/memory`, ready, openFirst, routeBriefs));
  }
  // Two projects that share a name: Overview names the collision, a link to each.
  // A dream in Memory's activity: its run card.
  expectFit("memory activity, a dream", await onPhone(`${server.baseUrl}/memory?view=activity`, 'button:has-text("1 archived")', undefined, async (page) => {
    await page.route("**/api/memory/dream/runs?**", (route) => route.fulfill({ json: { runs: [dreamRun] } }));
  }));
  // A dream's run opened: what it changed, a previous version.
  expectFit("memory, a dream run open", await onPhone(`${server.baseUrl}/memory?view=activity`, "text=project-1 releases are tagged", async (page) => {
    // The run's card, by its tally.
    await page.locator('button:has-text("1 archived")').first().tap();
    await page.getByRole("dialog").waitFor();
  }, async (page) => {
    await page.route("**/api/memory/dream/runs?**", (route) => route.fulfill({ json: { runs: [dreamRun] } }));
    await page.route("**/api/memory/dream/runs/run1", (route) => route.fulfill({ json: { run: dreamRun, actions: dreamActions } }));
  }));
  // Browse with a filter and a search: chips, Clear all, the field's clear.
  expectFit("memory browse, filtered and searched", await onPhone(`${server.baseUrl}/memory?view=browse&scope=project`, '[aria-label="Search memories"]', async (page) => {
    await page.locator('[aria-label="Search memories"]').fill("project-1");
    await page.locator('[aria-label="Search memories"]').press("Enter");
    await page.getByRole("button", { name: "Clear search" }).waitFor();
    await page.getByRole("button", { name: "Clear all" }).waitFor();
  }));
  // Three filters and a search at 320px: the chips wrap.
  expectFit("memory browse, many filters at 320", await onDevice(NARROW, `${server.baseUrl}/memory?view=browse&scope=project&type=knowledge&status=all&q=project-1`, '[aria-label="Search memories"]', async (page) => {
    await page.getByRole("button", { name: "Clear all" }).waitFor();
  }));
  // A project filter with a long name and a search at 320px: Clear all lands
  // under the search field's clear.
  expectFit("memory browse, a long project at 320", await onDevice(NARROW, `${server.baseUrl}/memory?view=browse`, '[aria-label="Search memories"]', async (page) => {
    const projectId = await page.evaluate(async () => (await (await fetch("/api/memory/stats")).json() as { byProject: Array<{ projectId: string }> }).byProject[0]!.projectId);
    await page.goto(`${server.baseUrl}/memory?view=browse&project=${encodeURIComponent(projectId)}&q=project-1`);
    await page.getByRole("button", { name: "Clear all" }).waitFor();
  }, async (page) => {
    await page.route("**/api/memory/stats", async (route) => {
      const response = await route.fetch();
      // A name whose chip leaves Clear all room on the first row, at its end.
      const name = "project-1-release-automation-tools-stable";
      const body = await response.json() as { byProject: Array<{ projectId: string; name: string }>; projectNames?: Record<string, string> };
      const projectNames = Object.fromEntries(body.byProject.map((p) => [p.projectId, name]));
      await route.fulfill({ response, json: { ...body, byProject: body.byProject.map((p) => ({ ...p, name })), projectNames } });
    });
  }));
  expectFit("memory, two projects share a name", await onPhone(`${server.baseUrl}/memory`, "text=projects share the name", undefined, async (page) => {
    await page.route("**/api/memory/stats", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { byProject: Array<{ projectId: string; name: string; count: number }> };
      // Six of them, so the links wrap.
      const twins = Array.from({ length: 5 }, (_, i) => ({ projectId: `proj-twin-${i}`, name: body.byProject[0]!.name, count: 10 + i }));
      await route.fulfill({ response, json: { ...body, byProject: [...body.byProject, ...twins] } });
    });
  }));
  for (const view of ["", "?view=activity"]) {
    expectFit(`memory${view} at 320`, await onDevice(NARROW, `${server.baseUrl}/memory${view}`, "text=project-1 releases are tagged"));
  }
}, 120_000);


test("Activity: overview, breakdown, logs", async () => {
  for (const tab of ["", "?tab=breakdown"]) {
    expectFit(`activity${tab}`, await onPhone(`${server.baseUrl}/activity${tab}`, '[data-slot="activity-window"]'));
  }
  // Group by wraps at 320px; a filter shows Clear in the log's header (the
  // log as it is otherwise: every seeded call succeeded, so the same rows).
  expectFit("activity?tab=breakdown at 320", await onDevice(NARROW, `${server.baseUrl}/activity?tab=breakdown`, '[data-slot="activity-window"]'));
  expectFit("activity logs, filtered", await onPhone(`${server.baseUrl}/activity?tab=logs&status=succeeded`, 'button:has-text("Clear")'));
  expectFit("activity logs, a select open", await onPhone(`${server.baseUrl}/activity?tab=logs`, '[aria-label="Status"]', async (page) => {
    await page.locator('[aria-label="Status"]').tap();
    await page.getByRole("option").first().waitFor();
  }));
  // Older calls fail, so the log's foot is the failure and its Retry rather than loading.
  expectFit("activity logs, a call open", await onPhone(`${server.baseUrl}/activity?tab=logs`, "[data-log-row]", async (page) => {
    await page.locator("[data-log-row]").first().tap();
    await page.getByTitle("Copy JSON").first().waitFor();
  }));
  expectFit("activity logs, older calls", await onPhone(`${server.baseUrl}/activity?tab=logs`, '[data-slot="activity-window"]', async (page) => {
    const retry = page.locator('[data-slot="inline-error"]').getByRole("button", { name: "Retry", exact: true });
    await page.getByRole("button", { name: /older/ }).scrollIntoViewIfNeeded();
    await retry.waitFor();
    await retry.scrollIntoViewIfNeeded();
  }, async (page) => {
    await page.route("**/api/activity/calls?*", (route) => new URL(route.request().url()).searchParams.has("before")
      ? route.fulfill({ status: 500, json: { error: "older failed" } })
      : route.fallback());
  }));
}, 90_000);

// A read that failed leaves its Retry where the content would be, right under
// the page's own controls.
test("Memory and Activity: what a failed read leaves to tap", async () => {
  const fail = (pattern: string) => async (page: Page) => {
    await page.route(pattern, (route) => route.fulfill({ status: 500, json: { error: "database is locked" } }));
  };
  const retry = '[data-slot="inline-error"] button';
  const TOUCH_600 = { viewport: { width: 600, height: 900 }, isMobile: true, hasTouch: true };
  expectFit("memory browse, searched, failed", await onPhone(`${server.baseUrl}/memory?view=browse&q=project-1`, retry, undefined, fail("**/api/memory/entries?*")));
  expectFit("memory browse, searched, failed at 320", await onDevice(NARROW, `${server.baseUrl}/memory?view=browse&q=project-1`, retry, undefined, fail("**/api/memory/entries?*")));
  expectFit("memory activity, failed at 600", await onDevice(TOUCH_600, `${server.baseUrl}/memory?view=activity`, retry, undefined, fail("**/api/memory/entries?*")));
  expectFit("memory activity, failed", await onPhone(`${server.baseUrl}/memory?view=activity`, retry, undefined, fail("**/api/memory/entries?*")));
  expectFit("memory overview, failed", await onPhone(`${server.baseUrl}/memory`, retry, undefined, fail("**/api/memory/stats")));
  expectFit("activity, failed", await onPhone(`${server.baseUrl}/activity`, retry, undefined, fail("**/api/activity/summary?*")));
  expectFit("activity logs, failed", await onPhone(`${server.baseUrl}/activity?tab=logs`, retry, undefined, fail("**/api/activity/calls?*")));
}, 90_000);
