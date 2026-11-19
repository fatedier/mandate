import type { StickyNoteDto } from "../../src/shared/api/sticky-notes.js";
import type { ManagerThreadDto } from "../../src/shared/api/agents.js";
import type { DutySummaryDto, ScheduleDto } from "../../src/shared/api/schedules.js";
import type { MemoryEntryDto } from "../../src/shared/api/memory.js";
import type { TaskDetailDto, TaskDto } from "../../src/shared/api/task-board.js";
import type { ProjectWorker, Project } from "../../src/client/store/projects.js";
import type { ThreadWorker } from "../../src/client/hooks/useThreadWorkers.js";

/**
 * Client fixtures for what the stores hold: a worker (Worker), its project,
 * a manager thread, and a worker as a thread lists it. Each reads as an
 * ordinary case; `over` sets anything particular to a test.
 */

const AT = "2026-09-27T00:00:00.000Z";

/** A live worker in project p1 owned by thread thr_a, named and windowed as its id, sharing the project's directory. */
export function clientWorker(id: string, over: Partial<ProjectWorker> = {}): ProjectWorker {
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
    tmuxStatus: "alive",
    workers: [],
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
    duty: null,
    labels: [],
    projects: [],
    ...over
  };
}

/** An active daily schedule of thread thr_a, due tomorrow at 09:00 UTC, never run yet, no check running. */
export function scheduleDto(id: string, over: Partial<ScheduleDto> = {}): ScheduleDto {
  return {
    id, threadId: "thr_a", name: "greenhouse daily check", cron: "0 9 * * *", cronText: "Daily 09:00", timezone: "UTC",
    status: "active", pausedReason: null, nextDueAt: "2026-09-28T09:00:00.000Z", lastRunAt: null, lastOutcome: null,
    consecutiveFailures: 0, checksRun: 0, running: false, briefLine: "Watch the greenhouse's soil moisture.", ...over
  };
}

/** A duty thread's summary: one schedule (scheduleDto "sch_1"), level investigate, schedules on, nothing reported, not in the sidebar. */
export function dutySummaryDto(over: Partial<DutySummaryDto> = {}): DutySummaryDto {
  return { level: "investigate", schedules: [scheduleDto("sch_1")], schedulesOff: false, reportedSeq: null, sidebarAddedAt: null, ...over };
}

/** A worker of thread thr_a in project-1, named and slugged as its id, in progress and idle: not waiting, asking, running or watching, and no plan step in progress. */
export function threadWorker(workerId: string, over: Partial<ThreadWorker> = {}): ThreadWorker {
  return {
    workerId,
    name: workerId,
    projectId: "p1",
    projectName: "project-1",
    projectSlug: "project-1",
    workerSlug: workerId,
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

let memorySeq = 0;

/** An available knowledge memory of the user's that an agent wrote on
 *  2026-07-28, saying "something"; ids run mem_1, mem_2, … through a file. */
export function memoryEntry(over: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: `mem_${++memorySeq}`,
    scope: "user",
    projectId: null,
    workerId: null,
    type: "knowledge",
    status: "available",
    content: "something",
    source: "agent",
    userQuote: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    metadata: null,
    ...over
  };
}

/** A task as the board sends it: Todo, no due date, no thread, nothing said. */
export function taskDto(id: string, over: Partial<TaskDto> = {}): TaskDto {
  return {
    id, title: `Task ${id}`, description: "", status: "todo", dueDate: null, dueTime: null,
    result: null, resultAt: null, createdAt: "2026-11-01T09:00:00.000Z", createdBy: "owner",
    updatedAt: "2026-11-01T09:00:00.000Z", statusAt: "2026-11-01T09:00:00.000Z", deletedAt: null, threads: [], labels: [],
    marks: { needsYou: false, failed: false, quiet: false }, lastComment: null, unanswered: 0,
    ...over
  };
}

/** A task with its stream, as the detail reads it. */
export function taskDetailDto(id: string, over: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return { ...taskDto(id, over), entries: [], ...over };
}

/** A sticky note as the server sends it: open, new, about nothing, from a morning. */
export function stickyNoteDto(id: string, over: Partial<StickyNoteDto> = {}): StickyNoteDto {
  return {
    id, title: `Note ${id}`, body: "What it says.", kind: "fyi", about: null,
    createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z", version: 1, seen: false,
    doneAt: null, doneBy: null, reason: null,
    ...over
  };
}
