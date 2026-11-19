import type { Project, ProjectWorker } from "@/store/projects";
import { listedThreads, type ListedThread } from "@/routes/threads/thread-list";
import { byDue } from "@/routes/task-board/task-format";
import type { ArchivedThreadDto, ManagerThreadDto } from "@shared/api/agents";
import type { TaskDto, TaskStatus } from "@shared/api/task-board";
import type { ThreadDot } from "@shared/thread-dot";

/** What a thread's mark says, for its place on a project's page: what asks
 *  for you (the solid dots), then what runs or waits on something, then the
 *  other open threads, then the archived ones (theirs is when they were
 *  archived, not their last activity: an archive is not activity). */
function threadRank(thread: ListedThread, dots: ReadonlyMap<string, ThreadDot>): number {
  if (thread.archived) return 3;
  const dot = dots.get(thread.id);
  if (dot === "failed" || dot === "needs_you" || dot === "decision" || dot === "result") return 0;
  if (dot === "working" || dot === "watching") return 1;
  return 2;
}

/** The threads whose workers ran in the project, open and archived (by the
 *  project's name, as threads name their projects): what wants you first,
 *  then what runs, then the other open ones, each part by last activity,
 *  then the archived ones by when they were archived. */
export function projectThreads(
  open: Iterable<ManagerThreadDto>,
  archived: readonly ArchivedThreadDto[],
  projectName: string,
  dots: ReadonlyMap<string, ThreadDot>
): ListedThread[] {
  const all = [...listedThreads(open, archived, "active"), ...listedThreads([], archived, "archived")];
  return all
    .filter((thread) => thread.projects.includes(projectName))
    .sort((a, b) => threadRank(a, dots) - threadRank(b, dots) || b.at.localeCompare(a.at));
}

const OPEN_ORDER: Partial<Record<TaskStatus, number>> = { review: 0, progress: 1, todo: 2 };

/** The board's open tasks with the project's label, in any case, as the
 *  board's label filter finds them: In review, In progress, then Todo,
 *  each by due. */
export function projectOpenTasks(tasks: Iterable<TaskDto>, projectName: string): TaskDto[] {
  const name = projectName.toLowerCase();
  return [...tasks]
    .filter((task) => OPEN_ORDER[task.status] !== undefined && task.labels.some((label) => label.name.toLowerCase() === name))
    .sort((a, b) => OPEN_ORDER[a.status]! - OPEN_ORDER[b.status]! || byDue(a, b));
}

/** The project's workers that are not archived: the ones it works with now. */
export function activeWorkers(project: Project): ProjectWorker[] {
  return project.workers.filter((worker) => !worker.archivedAt);
}

/** The names of a project's active workers that work in its own directory:
 *  what changing the directory moves. */
export function workersInProjectDir(project: Project): string[] {
  return project.workers.filter((w) => w.mode === "shared-cwd" && !w.archivedAt).map((w) => w.name);
}

/** "1 thread", "3 threads". */
export function countText(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
