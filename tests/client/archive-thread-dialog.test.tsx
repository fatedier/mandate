import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { toast } from "sonner";
import { ArchiveThreadDialog } from "@/routes/threads/ArchiveThreadDialog";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore, type Feature, type Project } from "@/store/projects";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { emptyPlan } from "@shared/api/plans";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { clientFeature, clientProject, managerThreadDto } from "../helpers/client-builders.js";

// A thread that still had workers refused to archive, with a toast naming
// them, and each had to be archived from its own dialog first. The thread's
// dialog lists its workers now, with what archiving each would lose, and
// archives them with the thread in one step.

const at = "2026-09-27T00:00:00.000Z";

afterEach(() => {
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false });
    useProjectsStore.getState().setProjectsState([]);
    useFeaturePlansStore.setState({ plans: new Map() });
  });
});

/** One with a worktree and a branch Mandate made for it. */
const made = (id: string, branch: string) => clientFeature(id, { mode: "new-branch-new-worktree", branch, baseRef: "main", worktreePath: `/project-1/.worktrees/${branch}` });
const project = (features: Feature[]): Project => clientProject("p1", { isGit: true, features });
const CLEAN = { dirtyFiles: 0, unmergedCommits: 0, branch: null, baseRef: null, findings: [] };
const found = (...findings: string[]) => ({ ...CLEAN, findings });

type Answer = Response | Promise<Response>;

/** The dialog for thread thr_a with these workers; `checks` answers each
 *  worker's archive check, `patch` the thread's archive. */
async function open(options: { workers: Feature[]; checks?: Record<string, () => Answer>; patch?: (body: Record<string, unknown>) => Answer }) {
  const sent: Array<Record<string, unknown>> = [];
  const checked: string[] = [];
  mockFetch(({ url, method, init }) => {
    const check = /\/api\/features\/([^/]+)\/archive-check$/.exec(url);
    if (method === "GET" && check) {
      checked.push(check[1]!);
      return options.checks?.[check[1]!]?.() ?? Response.json(CLEAN);
    }
    if (method === "PATCH" && url.endsWith("/threads/thr_a")) {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      sent.push(body);
      return options.patch?.(body) ?? Response.json({ thread: managerThreadDto("thr_a", { archivedAt: at }), workers: [], cleanupFailures: [] });
    }
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  });
  act(() => {
    useManagerThreadsStore.getState().replaceAll([managerThreadDto("thr_a"), managerThreadDto("thr_b", { title: "Sidebar" })]);
    useProjectsStore.getState().setProjectsState([project([...options.workers, clientFeature("elsewhere", { ownerThreadId: "thr_b" })])]);
  });
  let done = 0;
  let path = "";
  function Where() { path = useLocation().pathname; return null; }
  await mountAsync(
    <MemoryRouter initialEntries={["/threads/thr_a"]}>
      <ArchiveThreadDialog threadId="thr_a" onDone={() => { done += 1; }} />
      <Where />
    </MemoryRouter>
  );
  await settle();
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  const press = async (label: string) => {
    await act(async () => { button(label)!.click(); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
  };
  const rows = () => [...dialog().querySelectorAll<HTMLElement>('[data-slot="archive-worker"]')].map((row) => ({
    name: row.querySelector('[data-slot="worker-name"]')!.textContent,
    project: row.querySelector('[data-slot="worker-project"]')!.textContent,
    state: row.querySelector('[data-slot="worker-state"]')!.textContent,
    findings: row.querySelector('[data-slot="worker-findings"]')?.textContent ?? null
  }));
  const boxes = () => [...dialog().querySelectorAll<HTMLLabelElement>("label")].map((label) => ({
    label: label.querySelector("span > span:first-child")!.textContent,
    hint: label.querySelector("span > span:last-child")!.textContent,
    checked: label.querySelector("input")!.checked
  }));
  const untick = (label: string) => act(() => {
    [...dialog().querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent!.startsWith(label))!.querySelector("input")!.click();
  });
  return { sent, checked, dialog, button, press, rows, boxes, untick, done: () => done, path: () => path };
}

function toasts(): string[] {
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => { shown.push(String(message)); return ""; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  return shown;
}

test("a thread with no workers asks as it did: its name, no list, and Archive sends only the archive", async () => {
  const d = await open({ workers: [] });
  expect(d.dialog().querySelector('[data-slot="dialog-title"]')!.textContent).toBe("Archive “Release project-1 3.21”?");
  expect(d.dialog().querySelector('[data-slot="dialog-description"]')!.textContent).toBe("It moves to Archived in the sidebar, where you can still read it.");
  expect([d.rows(), d.boxes(), d.checked]).toEqual([[], [], []]);
  await d.press("Archive");
  expect(d.sent).toStrictEqual([{ archived: true }]);
  // Done, and away from the page of a thread that is no longer there.
  expect([d.done(), d.path()]).toEqual([1, "/home"]);
});

test("its workers are listed with their project and state, and said to go with it; another thread's is not", async () => {
  act(() => {
    const at2 = at;
    useFeaturePlansStore.setState({ plans: new Map([["notes", { ...emptyPlan("notes"), steps: [{ id: 1, title: "Write", status: "done" as const, note: "", createdAt: at2, startedAt: at2, blockedAt: null, completedAt: at2, updatedAt: at2 }] }]]) });
  });
  const d = await open({ workers: [clientFeature("notes"), clientFeature("loader")] });
  expect(d.dialog().querySelector('[data-slot="dialog-description"]')!.textContent)
    .toBe("It moves to Archived in the sidebar, where you can still read it. Its 2 workers are archived with it.");
  expect(d.rows()).toEqual([
    { name: "notes", project: "project-1", state: "Done", findings: null },
    { name: "loader", project: "project-1", state: "Planning", findings: null }
  ]);
  // Each is checked, once; they share a workspace with their project, so there is nothing to clean up.
  expect(d.checked).toStrictEqual(["notes", "loader"]);
  expect(d.boxes()).toEqual([]);
  // The list is rebuilt whenever a worker's state moves: that asks nothing
  // again. A worker that joins the thread meanwhile is checked when it does.
  act(() => { useFeaturePlansStore.setState({ plans: new Map() }); });
  await settle();
  expect([d.rows().map((row) => row.state), d.checked]).toEqual([["Planning", "Planning"], ["notes", "loader"]]);
  act(() => { useProjectsStore.getState().setProjectsState([project([clientFeature("notes"), clientFeature("loader"), clientFeature("late")])]); });
  await settle();
  expect([d.rows().map((row) => row.name), d.checked]).toEqual([["notes", "loader", "late"], ["notes", "loader", "late"]]);
  await d.press("Archive");
  expect(d.sent).toStrictEqual([{ archived: true }]);
  expect([d.done(), d.path()]).toEqual([1, "/home"]);
  // The answer is taken at once: the thread leaves the sidebar's list, the other stays.
  const threads = useManagerThreadsStore.getState().threads;
  expect([threads.has("thr_a"), threads.has("thr_b")]).toEqual([false, true]);
});

test("one worker is said in the singular", async () => {
  const d = await open({ workers: [clientFeature("notes")] });
  expect(d.dialog().querySelector('[data-slot="dialog-description"]')!.textContent)
    .toBe("It moves to Archived in the sidebar, where you can still read it. Its worker is archived with it.");
});

test("while a check is out its row says so and Archive waits", async () => {
  let answer: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { answer = resolve; });
  const d = await open({ workers: [clientFeature("notes"), clientFeature("loader")], checks: { loader: () => pending } });
  expect(d.rows().map((row) => row.state)).toEqual(["Planning", "Checking…"]);
  expect(d.button("Archive")!.disabled).toBe(true);
  await act(async () => { answer(Response.json(CLEAN)); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(d.rows().map((row) => row.state)).toEqual(["Planning", "Planning"]);
  expect(d.button("Archive")!.disabled).toBe(false);
});

test("what a check found stands on that worker's row, and the one button archives anyway, confirming that worker", async () => {
  const d = await open({
    workers: [clientFeature("notes"), clientFeature("loader")],
    checks: { loader: () => Response.json(found("3 uncommitted files in the worktree.", "2 commits on \"loader\" are not in main.")) }
  });
  expect(d.rows().map((row) => [row.name, row.findings])).toEqual([
    ["notes", null], ["loader", "3 uncommitted files in the worktree. 2 commits on \"loader\" are not in main."]
  ]);
  expect(d.button("Archive") === undefined).toBe(true);
  await d.press("Archive anyway");
  expect(d.sent).toStrictEqual([{ archived: true, confirmed: ["loader"] }]);
  expect([d.done(), d.path()]).toEqual([1, "/home"]);
});

test("the cleanup boxes are for workers with a worktree or branch Mandate made: one worker's in the worker dialog's words, several in the plural", async () => {
  const one = await open({ workers: [clientFeature("notes"), made("loader", "config-loader")] });
  expect(one.boxes()).toEqual([
    { label: "Remove worktree", hint: "Delete the Mandate-created worktree directory when it is clean.", checked: true },
    { label: "Delete branch", hint: "Delete local branch \"config-loader\" when it is safe.", checked: true }
  ]);
  await one.press("Archive");
  expect(one.sent).toStrictEqual([{ archived: true, removeWorktrees: true, deleteBranches: true }]);
  runCleanups();

  const two = await open({ workers: [made("notes", "release-notes"), made("loader", "config-loader")] });
  expect(two.boxes()).toEqual([
    { label: "Remove worktrees", hint: "Delete the worktree directories Mandate made, each when it is clean.", checked: true },
    { label: "Delete branches", hint: "Delete the local branches Mandate made, each when it is safe.", checked: true }
  ]);
  two.untick("Remove worktrees");
  await two.press("Archive");
  expect(two.sent).toStrictEqual([{ archived: true, removeWorktrees: false, deleteBranches: true }]);
  runCleanups();

  // The branches kept this time.
  const kept = await open({ workers: [made("notes", "release-notes"), made("loader", "config-loader")] });
  kept.untick("Delete branches");
  await kept.press("Archive");
  expect(kept.sent).toStrictEqual([{ archived: true, removeWorktrees: true, deleteBranches: false }]);
});

test("a worker on a branch that was there before gets the worktree box alone", async () => {
  const d = await open({ workers: [clientFeature("loader", { mode: "existing-branch-new-worktree", branch: "config-loader", worktreePath: "/project-1/.worktrees/config-loader" })] });
  expect(d.boxes().map((box) => box.label)).toEqual(["Remove worktree"]);
  d.untick("Remove worktree");
  await d.press("Archive");
  expect(d.sent).toStrictEqual([{ archived: true, removeWorktrees: false }]);
});

test("a refusal that comes back from the archive itself puts what was found on the rows and offers Archive anyway, with no toast", async () => {
  const shown = toasts();
  let asked = 0;
  const d = await open({
    workers: [clientFeature("notes"), clientFeature("loader")],
    patch: (body) => (++asked === 1
      ? Response.json({ error: "Archiving would lose work in: loader.", workers: [{ id: "loader", name: "loader", findings: ["1 uncommitted file in the worktree."] }], archived: [] }, { status: 409 })
      : Response.json({ thread: managerThreadDto("thr_a", { archivedAt: at }), workers: [], cleanupFailures: [], echoed: body }))
  });
  await d.press("Archive");
  expect(d.rows().map((row) => [row.name, row.findings])).toEqual([["notes", null], ["loader", "1 uncommitted file in the worktree."]]);
  expect([d.done(), d.path(), shown]).toEqual([0, "/threads/thr_a", []]);
  await d.press("Archive anyway");
  expect(d.sent).toStrictEqual([{ archived: true }, { archived: true, confirmed: ["loader"] }]);
  expect(d.done()).toBe(1);
});

test("a check that could not run says so on its row and leaves the check to the archive", async () => {
  const d = await open({ workers: [clientFeature("loader")], checks: { loader: () => Response.json({ error: "git status timed out" }, { status: 502 }) } });
  expect(d.rows()).toEqual([{ name: "loader", project: "project-1", state: "Couldn’t check", findings: null }]);
  expect(d.button("Archive")!.disabled).toBe(false);
  await d.press("Archive");
  expect(d.sent).toStrictEqual([{ archived: true }]);
});

test("any other failure is a toast, and the dialog stays for another try", async () => {
  const shown = toasts();
  const d = await open({ workers: [clientFeature("notes")], patch: () => Response.json({ error: "database is locked" }, { status: 500 }) });
  await d.press("Archive");
  expect(shown).toStrictEqual(["database is locked"]);
  expect([d.done(), d.path(), d.button("Archive")!.disabled]).toEqual([0, "/threads/thr_a", false]);
});

test("while the archive is out the buttons wait and say so", async () => {
  let answer: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { answer = resolve; });
  const d = await open({ workers: [made("loader", "config-loader")], patch: () => pending });
  await act(async () => { d.button("Archive")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(d.button("Archiving…")!.disabled).toBe(true);
  expect(d.button("Cancel")!.disabled).toBe(true);
  expect([...d.dialog().querySelectorAll("input")].every((box) => box.disabled)).toBe(true);
  await act(async () => { answer(Response.json({ thread: managerThreadDto("thr_a", { archivedAt: at }), workers: [], cleanupFailures: [] })); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(d.done()).toBe(1);
});

test("only the workers whose findings are on the page are confirmed: one whose check could not run is left to the archive, which shows what it finds", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const d = await open({
    workers: [clientFeature("notes"), clientFeature("loader"), clientFeature("docs")],
    checks: {
      loader: () => Response.json(found("3 uncommitted files in the worktree.")),
      docs: () => Response.json({ error: "git status timed out" }, { status: 502 })
    },
    patch: (body) => {
      sent.push(body);
      return sent.length === 1
        ? Response.json({ error: "Archiving would lose work in: docs.", workers: [
          { id: "docs", name: "docs", findings: ["1 commit on \"docs\" is not in main."] }
        ], archived: [], cleanupFailures: [] }, { status: 409 })
        : Response.json({ thread: managerThreadDto("thr_a", { archivedAt: at }), workers: [], cleanupFailures: [] });
    }
  });
  expect(d.rows().map((row) => [row.name, row.state, row.findings])).toEqual([
    ["notes", "Planning", null], ["loader", "Planning", "3 uncommitted files in the worktree."], ["docs", "Couldn’t check", null]
  ]);
  // What is shown is confirmed; the worker not checked here is not.
  await d.press("Archive anyway");
  expect(sent).toStrictEqual([{ archived: true, confirmed: ["loader"] }]);
  // The archive found something in it: on its row now, beside what was there.
  expect(d.rows().map((row) => [row.name, row.state, row.findings])).toEqual([
    ["notes", "Planning", null], ["loader", "Planning", "3 uncommitted files in the worktree."], ["docs", "Planning", "1 commit on \"docs\" is not in main."]
  ]);
  await d.press("Archive anyway");
  expect(sent.at(-1)).toEqual({ archived: true, confirmed: ["loader", "docs"] });
  expect(d.done()).toBe(1);
});

test("a worker this dialog could not check and the archive named nothing in is clean from then on", async () => {
  const d = await open({
    workers: [clientFeature("loader"), clientFeature("docs")],
    checks: { docs: () => Response.json({ error: "git status timed out" }, { status: 502 }) },
    patch: (body) => (Array.isArray(body.confirmed)
      ? Response.json({ thread: managerThreadDto("thr_a", { archivedAt: at }), workers: [], cleanupFailures: [] })
      : Response.json({ error: "Archiving would lose work in: loader.", workers: [{ id: "loader", name: "loader", findings: ["3 uncommitted files in the worktree."] }], archived: [], cleanupFailures: [] }, { status: 409 }))
  });
  expect(d.rows().map((row) => [row.name, row.state])).toEqual([["loader", "Planning"], ["docs", "Couldn’t check"]]);
  await d.press("Archive");
  expect(d.rows().map((row) => [row.name, row.state, row.findings])).toEqual([
    ["loader", "Planning", "3 uncommitted files in the worktree."], ["docs", "Planning", null]
  ]);
  await d.press("Archive anyway");
  expect(d.sent).toStrictEqual([{ archived: true }, { archived: true, confirmed: ["loader"] }]);
});

test("a worker the archive names that this page has not heard of yet is shown too, before anything can be confirmed", async () => {
  // The page's list of workers comes over the live feed and can trail the server.
  const refusal = { error: "Archiving would lose work in: loader, newcomer.", workers: [
    { id: "loader", name: "loader", findings: ["3 uncommitted files in the worktree."] },
    { id: "newcomer", name: "newcomer", findings: ["2 uncommitted files in the worktree."] }
  ], archived: [], cleanupFailures: [] };
  const d = await open({
    workers: [clientFeature("loader")],
    // Checked by this page once it hears of it: the same as the archive found.
    checks: { newcomer: () => Response.json(found("2 uncommitted files in the worktree.")) },
    patch: (body) => (Array.isArray(body.confirmed)
      ? Response.json({ thread: managerThreadDto("thr_a", { archivedAt: at }), workers: [], cleanupFailures: [] })
      : Response.json(refusal, { status: 409 }))
  });
  await d.press("Archive");
  expect(d.rows()).toEqual([
    { name: "loader", project: "project-1", state: "Planning", findings: "3 uncommitted files in the worktree." },
    { name: "newcomer", project: "", state: "", findings: "2 uncommitted files in the worktree." }
  ]);
  expect(d.dialog().querySelector('[data-slot="dialog-description"]')!.textContent)
    .toBe("It moves to Archived in the sidebar, where you can still read it. Its 2 workers are archived with it.");
  // Once the page hears of it, it has one row, the page's own.
  act(() => { useProjectsStore.getState().setProjectsState([project([clientFeature("loader"), clientFeature("newcomer")])]); });
  await settle();
  expect(d.rows().map((row) => [row.name, row.project, row.findings])).toEqual([
    ["loader", "project-1", "3 uncommitted files in the worktree."], ["newcomer", "project-1", "2 uncommitted files in the worktree."]
  ]);
  expect(d.checked).toStrictEqual(["loader", "newcomer"]);
  await d.press("Archive anyway");
  // Both were shown, the stranger too: both are confirmed.
  expect(d.sent).toStrictEqual([{ archived: true }, { archived: true, confirmed: ["loader", "newcomer"] }]);
});

test("a stranger alone is enough to ask for a confirmation", async () => {
  const d = await open({
    workers: [clientFeature("loader")],
    patch: () => Response.json({ error: "Archiving would lose work in: newcomer.", workers: [{ id: "newcomer", name: "newcomer", findings: ["2 uncommitted files in the worktree."] }], archived: [], cleanupFailures: [] }, { status: 409 })
  });
  await d.press("Archive");
  expect(d.rows().map((row) => [row.name, row.findings])).toEqual([["loader", null], ["newcomer", "2 uncommitted files in the worktree."]]);
  expect([d.button("Archive") === undefined, d.button("Archive anyway")!.disabled]).toEqual([true, false]);
  await d.press("Archive anyway");
  expect(d.sent.at(-1)).toEqual({ archived: true, confirmed: ["newcomer"] });
});
