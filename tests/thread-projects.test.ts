import { afterEach, expect, test } from "bun:test";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { ManagerThreadService, startManagerThreadBroadcast } from "../src/server/modules/agent/manager-threads.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { workRanIn } from "../src/server/modules/task-board/work-ran-in.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import type { ManagerThreadDto } from "../src/shared/api/agents.js";
import { freshStoresEnv, seedProject, seedWorker, type StoresEnv } from "./helpers/fixtures.js";

// A thread says which projects its workers ran in: the workers it owns,
// archived ones too, each project once, in the order the workers were made.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup(prefix: string) {
  env = freshStoresEnv(prefix);
  const { agentStore, workers, projects } = env;
  const ranIn = workRanIn({ workersStore: workers, projectsStore: projects });
  const threadProjects = (threadId: string) => ranIn([threadId]);
  const billing = seedProject(projects, { name: "project-billing", tmuxSessionName: "project-billing" });
  const voice = seedProject(projects, { name: "project-voice", tmuxSessionName: "project-voice" });
  let made = 0;
  const worker = (projectId: string, threadId: string) => {
    made += 1;
    const id = seedWorker(workers, projectId, { name: `Worker${made}`, tmuxWindowName: `w${made}`, ownerThreadId: threadId });
    // Made a minute apart, as workers are: inserts in one millisecond tie.
    env!.store.db.prepare("update workers set created_at = ? where id = ?").run(`2026-03-01T08:${String(made).padStart(2, "0")}:00.000Z`, id);
    return id;
  };
  return { env, agentStore, workers, threadProjects, billing, voice, worker, thread: (title: string) => agentStore.createManagerThread(title).id };
}

test("a thread's DTO names the projects its workers ran in, archived workers included, in the order they were made", () => {
  const t = setup("md-thp-dto-");
  const id = t.thread("Billing research");
  const first = t.worker(t.voice, id);
  t.worker(t.billing, id);
  t.worker(t.voice, id);
  t.workers.archive(first);
  const other = t.thread("Unrelated");
  const threads = new ManagerThreadService({ agentStore: t.agentStore, projects: t.threadProjects });
  expect(threads.dto(id)?.projects).toEqual(["project-voice", "project-billing"]);
  expect(threads.dto(other)?.projects).toEqual([]);
  // A service that is not told where work ran says nothing of it.
  expect(new ManagerThreadService({ agentStore: t.agentStore }).dto(id)?.projects).toEqual([]);
});

test("the archived list names each thread's projects", () => {
  const t = setup("md-thp-archived-");
  const old = t.thread("Old research");
  t.worker(t.billing, old);
  const bare = t.thread("Bare");
  t.agentStore.archiveThread(old);
  t.agentStore.archiveThread(bare);
  const deletion = new ThreadDeletion({
    db: t.env.store.db, agentStore: t.agentStore, canvases: new CanvasStore(t.env.store.db, t.env.dir), projects: t.threadProjects
  });
  expect(Object.fromEntries(deletion.archivedThreads().map((a) => [a.id, a.projects]))).toEqual({ [old]: ["project-billing"], [bare]: [] });
});

test("a worker joining a thread publishes it, and the thread it left", async () => {
  const t = setup("md-thp-joined-");
  const from = t.thread("Billing research");
  const to = t.thread("Voice research");
  const moved = t.worker(t.billing, from);
  const sent: ManagerThreadDto[] = [];
  const sse = { emit: (event: string, data: unknown) => { if (event === SSE_EVENTS.managerThreadUpdated) sent.push((data as { thread: ManagerThreadDto }).thread); }, addSink: () => () => {} };
  const service = new ManagerThreadService({ agentStore: t.agentStore, sse: sse as never, projects: t.threadProjects });
  const stop = startManagerThreadBroadcast({ sse: sse as never, service, agentStore: t.agentStore, workers: t.workers });
  t.workers.setOwner(moved, to);
  await Promise.resolve();
  expect(Object.fromEntries(sent.map((thread) => [thread.id, thread.projects]))).toEqual({ [from]: [], [to]: ["project-billing"] });
  // A worker made for a thread tells it too.
  sent.length = 0;
  t.worker(t.voice, to);
  await Promise.resolve();
  expect(sent.map((thread) => [thread.id, thread.projects])).toEqual([[to, ["project-billing", "project-voice"]]]);
  stop();
  sent.length = 0;
  t.workers.setOwner(moved, from);
  await Promise.resolve();
  expect(sent).toEqual([]);
});
