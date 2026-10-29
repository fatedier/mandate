import type { ManagerThreadDto } from "../../src/shared/api/agents.js";
import type { Feature, Project } from "../../src/client/store/projects.js";
import type { ThreadWorker } from "../../src/client/hooks/useThreadWorkers.js";

/**
 * Client fixtures for what the stores hold: a worker (Feature), its project,
 * a manager thread, and a worker as a thread lists it. Each reads as an
 * ordinary case; `over` sets anything particular to a test.
 */

const AT = "2026-09-27T00:00:00.000Z";

/** A live worker in project p1 owned by thread thr_a, named and windowed as its id, sharing the project's directory. */
export function clientFeature(id: string, over: Partial<Feature> = {}): Feature {
  return {
    id,
    projectId: "p1",
    name: id,
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: id,
    ownership: "app",
    pinnedAt: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    ownerThreadId: "thr_a",
    tmuxAlive: true,
    ...over
  };
}

/** A live, non-git project named project-1 at /project-1, first in the list, with no workers. */
export function clientProject(id: string, over: Partial<Project> = {}): Project {
  return {
    id,
    name: "project-1",
    workingDir: "/project-1",
    isGit: false,
    gitRemote: null,
    tmuxSessionName: "project-1",
    ownership: "app",
    sortOrder: 0,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    tmuxAlive: true,
    features: [],
    ...over
  };
}

/** A named manager thread at rest: nothing unread, no failure, no questions, not archived. */
export function managerThreadDto(id: string, over: Partial<ManagerThreadDto> = {}): ManagerThreadDto {
  return {
    id,
    title: "Release project-1 3.21",
    named: true,
    createdAt: AT,
    lastActivityAt: AT,
    lastVisibleSeq: 0,
    seenSeq: 0,
    running: false,
    failed: false,
    stopReason: null,
    questions: [],
    archivedAt: null,
    ...over
  };
}

/** A worker of thread thr_a in project-1, named and slugged as its id, in progress and idle: not waiting, asking, running or watching, and no plan step in progress. */
export function threadWorker(featureId: string, over: Partial<ThreadWorker> = {}): ThreadWorker {
  return {
    featureId,
    name: featureId,
    projectId: "p1",
    projectName: "project-1",
    projectSlug: "project-1",
    featureSlug: featureId,
    ownerThreadId: "thr_a",
    state: "in_progress",
    waiting: null,
    asking: false,
    running: false,
    watching: null,
    stepInProgress: false,
    ...over
  };
}
