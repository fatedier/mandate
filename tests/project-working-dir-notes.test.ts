import { afterEach, expect, test } from "bun:test";
import { noteWorkingDirChanged } from "../src/server/modules/projects/working-dir-notes.js";
import { projectChangeOf } from "../src/shared/project-change.js";
import { freshStoresEnv, seedFeature, seedProject, type StoresEnv } from "./helpers/fixtures.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const FROM = "/srv/checkouts/project-1-old";
const TO = "/srv/checkouts/project-1";

function setup(busy: (threadId: string) => boolean = () => false) {
  env = freshStoresEnv("md-workdir-notes-");
  const emitted: string[] = [];
  const projectId = seedProject(env.projects, { name: "project-1", workingDir: TO });
  const manager = env.agentStore.createManagerThread("Search timeout");
  const worker = (name: string, overrides: Parameters<typeof seedFeature>[2] = {}) =>
    seedFeature(env!.features, projectId, { name, tmuxWindowName: name, ownerThreadId: manager.id, ...overrides });
  const notify = () => noteWorkingDirChanged({
    agentStore: env!.agentStore, features: env!.features,
    sse: { emit: (event, data) => { emitted.push(`${event}:${(data as { threadId: string }).threadId}`); } },
    isThreadBusy: busy
  }, { project: env!.projects.getById(projectId)!, from: FROM });
  const rows = (threadId: string) => env!.agentStore.getActiveMessages(threadId).filter((m) => m.source === "project-change");
  return { env, emitted, manager, worker, notify, rows };
}

test("a worker in the project's directory and its manager are told, at once while they rest; nobody is woken, and a worker in its own worktree is not told", () => {
  const s = setup();
  const docs = s.worker("docs");
  const search = s.worker("search", { mode: "new-branch-new-worktree", branch: "search", worktreePath: "/srv/worktrees/search" });
  const docsChat = s.env.agentStore.getOrCreateThread("worker", docs);
  const searchChat = s.env.agentStore.getOrCreateThread("worker", search);
  s.notify();
  const [toWorker] = s.rows(docsChat.id);
  expect([toWorker!.role, toWorker!.content.type === "text" && toWorker!.content.text]).toEqual(["user",
    `[Project change] The user changed the working directory of project "project-1" from ${FROM} to ${TO}. ` +
    `Your shell and file tools start in ${TO} from now on; panes already open in your window keep running in ${FROM} until they are restarted.`]);
  expect(projectChangeOf(toWorker!.content)).toEqual({ projectId: expect.any(String), projectName: "project-1", from: FROM, to: TO });
  const [toManager] = s.rows(s.manager.id);
  expect(toManager!.content.type === "text" && toManager!.content.text).toBe(
    `[Project change] The user changed the working directory of project "project-1" from ${FROM} to ${TO}. ` +
    `Worker "docs" works in the project directory: panes already open in its window keep running in ${FROM} until they are restarted.`);
  expect(s.rows(searchChat.id)).toEqual([]);
  expect(s.emitted).toStrictEqual([`agentMessageAppended:${docsChat.id}`, `agentMessageAppended:${s.manager.id}`]);
  expect([s.env.agentStore.hasQueuedMailboxMessages(docsChat.id), s.env.agentStore.hasQueuedMailboxMessages(s.manager.id)]).toEqual([false, false]);
});

test("a manager with several workers in the project's directory is told once, naming them; a worker that never had a chat is not written to", () => {
  const s = setup();
  const docs = s.worker("docs");
  s.worker("api");
  s.notify();
  expect(s.rows(s.manager.id).map((m) => m.content.type === "text" && m.content.text.split(". ").at(-1))).toStrictEqual([
    `Workers "api" and "docs" work in the project directory: panes already open in their windows keep running in ${FROM} until they are restarted.`
  ]);
  expect(s.env.agentStore.getThreadByScope("worker", docs)).toBeNull();
});

test("with no worker in the project's directory nobody is told", () => {
  const s = setup();
  s.worker("search", { mode: "new-branch-new-worktree", branch: "search", worktreePath: "/srv/worktrees/search" });
  s.notify();
  expect([s.rows(s.manager.id), s.emitted]).toEqual([[], []]);
});

test("mid-turn the note waits in the mailbox for the next step and starts no turn", () => {
  const s = setup(() => true);
  const docs = s.worker("docs");
  const chat = s.env.agentStore.getOrCreateThread("worker", docs);
  s.notify();
  expect([s.rows(chat.id), s.rows(s.manager.id), s.emitted]).toEqual([[], [], []]);
  expect([s.env.agentStore.hasQueuedMailboxMessages(chat.id), s.env.agentStore.hasQueuedMailboxMessages(s.manager.id)]).toEqual([false, false]);
  const wake = s.env.agentStore.createWake({ threadId: chat.id, reason: "user", triggerMessageId: null });
  expect(s.env.agentStore.drainMailboxToMessages(chat.id, wake.id).map((m) => m.source)).toEqual(["project-change"]);
});

test("a manager thread archived is not written to", () => {
  const s = setup();
  s.worker("docs");
  s.env.agentStore.archiveThread(s.manager.id);
  s.notify();
  expect(s.rows(s.manager.id)).toEqual([]);
});

