import { afterAll, beforeAll, test } from "bun:test";
import { type Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { startTouchHarness, stopTouchHarness, onPhone, onDevice, expectFit, NARROW, emptyPlanFor, changes } from "./helpers/touch-targets";

// Touch targets: a worker in its thread's sheet and on its page.
// The rule and the measurement are in helpers/touch-targets.ts.
beforeAll(async () => {
  await startTouchHarness({ server: false });
}, 60_000);
afterAll(stopTouchHarness);


test("a worker: in its thread's sheet, and on its page's tabs", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  // The thread's archived workers: one.
  const routeArchived = async (page: Page) => {
    await page.route("**/workers?archived=1", (route) => route.fulfill({ json: { workers: [
      { featureId: "other-worker", name: "other-worker", projectId: "zoom-project", projectName: "Zoom project", workerThreadId: null, archivedAt: new Date().toISOString() }
    ] } }));
  };
  const routeChanges = (answer: (isFile: boolean) => Response | object) => async (page: Page) => {
    await page.route("**/api/features/zoom-worker/changes**", async (route) => {
      const isFile = new URL(route.request().url()).pathname.endsWith("/file");
      const body = answer(isFile);
      await (body instanceof Response ? route.fulfill({ status: body.status, json: await body.json() }) : route.fulfill({ json: body }));
    });
  };
  try {
    expectFit("worker sheet", await onPhone(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[data-slot="worker-sheet"] [role="tab"]'));
    // A worker named "x": its tab still has 44px to select beside Close.
    expectFit("worker sheet, a one-letter worker", await onPhone(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[aria-label="Close x"]', undefined,
      async (page) => {
        await page.addInitScript((threadId) => {
          const x = { featureId: "x", name: "x", projectId: "zoom-project", projectName: "Zoom project", workerThreadId: null, archivedAt: new Date().toISOString() };
          const panel = { open: true, tabs: ["zoom-worker", "archived:x"], active: "zoom-worker", workerTab: {}, archived: { "archived:x": x } };
          localStorage.setItem("mandate.worker-panel.v1", JSON.stringify({ state: { byThread: { [threadId]: panel } }, version: 0 }));
        }, THREAD_ID);
      }));
    // Two workers open: a tab's Close sits beside the next tab.
    expectFit("worker sheet, two tabs", await onPhone(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[aria-label="Close other-worker"]', undefined,
      async (page) => {
        await page.addInitScript((threadId) => {
          const panel = { open: true, tabs: ["zoom-worker", "other-worker"], active: "zoom-worker", workerTab: {} };
          localStorage.setItem("mandate.worker-panel.v1", JSON.stringify({ state: { byThread: { [threadId]: panel } }, version: 0 }));
        }, THREAD_ID);
      }));
    // Plan's tabs are measured below, on a plan with steps.
    for (const tab of ["chat", "terminal"]) {
      expectFit(`worker ${tab}`, await onPhone(`${fixture.baseUrl}${WORKER_PATH}?tab=${tab}`, '[role="tablist"] [role="tab"]'));
    }
    // The list is fetched after the tab shows: wait for a row and its menu.
    // (This state asked for ?tab=canvases, which is no tab: it measured Plan.)
    expectFit("worker reports", await onPhone(`${fixture.baseUrl}${WORKER_PATH}?tab=reports`, '[data-slot="canvas-row"] button[aria-label^="Canvas actions"]'));
    // The terminal page's top bar is the breadcrumb, its project and worker
    // linking back (at rest it is measured with the keys shown, below).
    const terminal = async (page: Page) => { await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send("user@mac zoom % "); }); };
    expectFit("worker's terminal, switching panes", await onPhone(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`, 'nav[aria-label="Breadcrumb"] a', async (page) => {
      await page.getByRole("button", { name: "Switch window or pane" }).tap();
      await page.locator('[data-slot="switcher-clear"]').waitFor();
    }, async (page) => {
      await terminal(page);
      // The session's two windows, the other one's pane opened before.
      const pane = (paneId: string, currentCommand: string) => ({ paneId, index: 0, active: true, currentCommand, currentPath: "/tmp/zoom-fixture" });
      await page.route("**/api/tmux/sessions", (route) => route.fulfill({ json: { sessions: [{
        name: "zoom-project", ownership: "managed", projectId: "zoom-project", projectName: "Zoom project", windows: [
          { name: "zoom-worker", windowId: "@0", index: 0, active: true, panes: [pane("%0", "zsh")] },
          { name: "other-worker", windowId: "@1", index: 1, active: false, panes: [pane("%1", "vim")] }
        ]
      }] } }));
      await page.addInitScript(() => {
        localStorage.setItem("mandate.ui", JSON.stringify({ state: { recentPanes: [{ sessionName: "zoom-project", windowName: "other-worker", paneId: "%1", at: new Date().toISOString() }] }, version: 0 }));
      });
    }));
    const showKeys = async (page: Page) => {
      await page.getByRole("button", { name: "Terminal actions" }).tap();
      await page.getByRole("menuitem", { name: "Show keys" }).tap();
      await page.getByRole("button", { name: "Escape" }).waitFor();
    };
    expectFit("worker's terminal, keys shown", await onPhone(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`, 'nav[aria-label="Breadcrumb"] a', showKeys, terminal));
    expectFit("worker's terminal at 320, keys shown", await onDevice(NARROW, `${fixture.baseUrl}${WORKER_PATH}/pane/%250`, 'nav[aria-label="Breadcrumb"] a', showKeys, terminal));
    expectFit("worker sheet, its workers", await onPhone(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[data-slot="worker-sheet"] [role="tab"]', async (page) => {
      await page.locator('[data-slot="worker-sheet"] [role="tab"]').first().tap();
      await page.getByRole("button", { name: "Archived" }).tap();
      await page.getByRole("button", { name: /other-worker/ }).waitFor();
    }, routeArchived));
    expectFit("worker sheet, an archived worker", await onPhone(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[data-slot="worker-sheet"] [role="tab"]', async (page) => {
      await page.locator('[data-slot="worker-sheet"] [role="tab"]').first().tap();
      await page.getByRole("button", { name: "Archived" }).tap();
      await page.getByRole("button", { name: /other-worker/ }).tap();
      await page.getByRole("tab", { name: "Plan" }).last().waitFor();
    }, routeArchived));
    // A report canvas's menu: a zoom stepper of two icon-only items.
    expectFit("canvas, its menu open", await onPhone(`${fixture.baseUrl}/canvas/zoom-canvas`, 'button[aria-label="Canvas menu"]', async (page) => {
      await page.getByRole("button", { name: "Canvas menu" }).tap();
      await page.getByRole("menuitem", { name: "Zoom in" }).waitFor();
    }));
    expectFit("worker sheet at 320", await onDevice(NARROW, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[data-slot="worker-sheet"] [role="tab"]'));
    // A plan with steps: rows, the earlier ones folded, a note that is a link,
    // and the changes line.
    const step = (id: number, status: "done" | "in_progress" | "pending", note: string | null = null) => ({
      id, title: `Step ${id}: ${status === "done" ? "measured" : "measure"} the evict path`, status, note,
      createdAt: new Date().toISOString(), startedAt: null, blockedAt: null,
      completedAt: status === "done" ? new Date().toISOString() : null, updatedAt: new Date().toISOString()
    });
    fixture.setPlan({ ...emptyPlanFor("zoom-worker"), goal: "Fix the cache expiry leak", steps: [
      ...Array.from({ length: 7 }, (_, i) => step(i + 1, "done")), step(8, "in_progress", "https://github.com/acmecorp/project-1/issues/1"), step(9, "pending")
    ] });
    // Its task record's row is measured with the rest of the Plan tab.
    fixture.setRecord("zoom-worker", { id: "mem_rec1", content: "Fix the cache expiry leak\nDone: measured", updatedAt: new Date().toISOString() });
    expectFit("worker plan, with steps", await onPhone(`${fixture.baseUrl}${WORKER_PATH}?tab=plan`, '[data-slot="plan-step"]', async (page) => {
      await page.locator('[data-slot="changes-summary"]').waitFor();
      await page.locator('[data-slot="plan-work-record"]').waitFor();
    }, routeChanges(() => changes)));
    fixture.setRecord("zoom-worker", null);
    fixture.setPlan({ ...emptyPlanFor("zoom-worker"), openQuestions: ["Keep the old flag, or drop it in this release?"] });
    expectFit("worker chat, a question", await onPhone(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`, 'button:has-text("Reply")'));
    // The screens after this one are of a worker that asks nothing.
    fixture.setPlan(emptyPlanFor("zoom-worker"));
    expectFit("worker changes", await onPhone(`${fixture.baseUrl}${WORKER_PATH}?tab=changes`, '[data-slot="changes-tab"] button[title="README.md"]', undefined,
      routeChanges(() => changes)));
    expectFit("worker changes, failed", await onPhone(`${fixture.baseUrl}${WORKER_PATH}?tab=changes`, '[data-slot="changes-tab"] button:has-text("Retry")', undefined,
      routeChanges(() => Response.json({ error: "worktree missing" }, { status: 500 }))));
    // A worker with a worktree and branch of its own: Archive offers to
    // clean both up, each a checkbox tapped through its label.
    fixture.setFeature("zoom-worker", { mode: "new-branch-new-worktree", branch: "zoom-worker", worktreePath: "/tmp/zoom-fixture/.worktrees/zoom-worker" });
    const openArchive = async (page: Page) => {
      await page.getByRole("button", { name: "Worker actions", exact: true }).first().tap();
      await page.getByRole("menuitem", { name: "Archive worker" }).tap();
      await page.getByText("Remove worktree", { exact: true }).waitFor();
      await page.getByText("Delete branch", { exact: true }).waitFor();
    };
    const cleanCheck = async (page: Page) => {
      await page.route("**/archive-check", (route) => route.fulfill({ json: { dirtyFiles: 0, unmergedCommits: 0, branch: "zoom-worker", baseRef: "main", findings: [] } }));
    };
    expectFit("worker archive, its cleanup boxes", await onPhone(`${fixture.baseUrl}${WORKER_PATH}`, '[role="tablist"] [role="tab"]', openArchive, cleanCheck));
    // Wider, each box's description fits one line and its label is shorter.
    expectFit("worker archive, its cleanup boxes at 600", await onDevice({ viewport: { width: 600, height: 900 }, isMobile: true, hasTouch: true },
      `${fixture.baseUrl}${WORKER_PATH}`, '[role="tablist"] [role="tab"]', openArchive, cleanCheck));
    // The thread's own archive takes its workers with it: a row for each,
    // the same two boxes, and Archive.
    expectFit("thread archive, its worker and cleanup boxes", await onPhone(`${fixture.baseUrl}/threads/${THREAD_ID}`, 'button[aria-label="Thread actions"]', async (page) => {
      await page.getByRole("button", { name: "Thread actions" }).tap();
      await page.getByRole("menuitem", { name: "Archive thread" }).tap();
      await page.locator('[data-slot="archive-worker"]').waitFor();
      await page.getByText("Remove worktree", { exact: true }).waitFor();
      await page.getByRole("dialog").locator("button:not([disabled])", { hasText: /^Archive$/ }).waitFor();
    }, cleanCheck));
    fixture.setFeature("zoom-worker", { mode: "shared-cwd", branch: "main", worktreePath: null });
  } finally {
    fixture.stop();
  }
}, 120_000);

test("a thread's Workers tab on a phone: a card, done lines, reports, and what folds past three", async () => {
  const fixture = startWorkspaceFixture();
  const at = new Date().toISOString();
  const step = (id: number, status: "done" | "in_progress" | "pending") => ({
    id, title: `Step ${id}: check the cache path`, status, note: null,
    createdAt: at, startedAt: null, blockedAt: null, completedAt: status === "done" ? at : null, updatedAt: at
  });
  // A worker at work with a goal and a step on; four done, so one folds.
  fixture.setPlan({ ...emptyPlanFor("zoom-worker"), goal: "Fix the cache expiry leak", steps: [step(1, "done"), step(2, "in_progress"), step(3, "pending")] });
  for (const id of ["done-one", "done-two", "done-three", "done-four"]) {
    fixture.addWorker(id);
    fixture.setPlan({ ...emptyPlanFor(id), conclusion: `Finished ${id}. Nothing left.`, steps: [step(1, "done")] });
  }
  // Four reports, so one folds.
  const reports = async (page: Page) => {
    await page.route("**/api/agents/manager/threads/*/canvases", (route) => route.fulfill({ json: { canvases: ["one", "two", "three", "four"].map((n) => ({
      id: `cnv_Report${n}`, title: `Report ${n}`, kind: "report", scope: "worker", scopeId: "zoom-worker", threadId: "zoom-thread",
      createdAt: at, updatedAt: at, projectId: "zoom-project", projectName: "Zoom project", projectSlug: "zoom-project",
      featureId: "zoom-worker", featureName: "zoom-worker", featureSlug: "zoom-worker"
    })) } }));
  };
  try {
    // The sheet at full height (opened on a worker, then its Workers tab), so
    // everything measured is on screen: what lies past the screen is not.
    const inSight = async (page: Page, selector: string) => {
      const box = (await page.locator(selector).first().boundingBox())!;
      if (box.y < 0 || box.y + box.height > 844) throw new Error(`${selector} is not on screen: ${JSON.stringify(box)}`);
    };
    expectFit("thread sheet, the Workers tab", await onPhone(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[data-slot="worker-sheet"] [role="tab"]', async (page) => {
      const sheet = page.locator('[data-slot="worker-sheet"]');
      await sheet.getByRole("tab", { name: /^Workers/ }).tap();
      await sheet.locator('[data-worker="zoom-worker"] [data-slot="worker-goal"]').waitFor();
      await sheet.getByRole("button", { name: "1 more", exact: true }).waitFor();
      // Come to rest at full height.
      await page.waitForTimeout(700);
      for (const selector of ['[data-worker="zoom-worker"]', '[data-slot="done-worker"]', 'button:has-text("1 more done")', '[data-slot="thread-canvas"]', 'section[aria-label="Reports and canvases"] button:has-text("1 more")']) {
        await inSight(page, `[data-slot="worker-sheet"] ${selector}`);
      }
    }, reports));
  } finally {
    fixture.stop();
  }
}, 60_000);
