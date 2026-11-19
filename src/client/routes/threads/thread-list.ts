import type { ArchivedThreadDto, ManagerThreadDto, ThreadLabelDto } from "@shared/api/agents";
import { NO_VALUE } from "@/lib/filter-parts";

/** The Threads page's two tabs. */
export type ThreadsTab = "active" | "archived";

/** A thread as the Threads page lists it, open or archived. */
export interface ListedThread {
  id: string;
  title: string;
  labels: ThreadLabelDto[];
  projects: string[];
  /** What the list is ordered by and its last column shows: an open
   *  thread's last activity, an archived one's archiving. */
  at: string;
  archived: boolean;
  /** On duty: an open thread with schedules. */
  duty: boolean;
}

/** A tab's threads, newest first: the open ones by last activity (duty
 *  threads among them), the archived ones by when they were archived. */
export function listedThreads(threads: Iterable<ManagerThreadDto>, archived: readonly ArchivedThreadDto[], tab: ThreadsTab): ListedThread[] {
  const listed: ListedThread[] = tab === "active"
    ? [...threads].map((t) => ({ id: t.id, title: t.title, labels: t.labels, projects: t.projects, at: t.lastActivityAt, archived: false, duty: t.duty !== null }))
    : archived.map((t) => ({ id: t.id, title: t.title, labels: t.labels, projects: t.projects, at: t.archivedAt, archived: true, duty: false }));
  return listed.sort((a, b) => b.at.localeCompare(a.at));
}

/** The Threads page filtered to one project, on a tab (Active unless
 *  named; useProjectFilterFromAddress). */
export function threadsForProjectHref(projectName: string, tab: ThreadsTab = "active"): string {
  const params = new URLSearchParams({ project: projectName });
  if (tab === "archived") params.set("tab", "archived");
  return `/threads?${params.toString()}`;
}

/** The search: in the title, any case. */
export function matchesQuery(thread: Pick<ListedThread, "title">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || thread.title.toLowerCase().includes(q);
}

export interface ThreadFilters {
  labels: string[];
  projects: string[];
}

/** A thread passes a group when it has any ticked value of it (labels
 *  whatever their case), or none with No label / No project ticked; both
 *  groups must pass, and an empty group passes. */
export function matchesFilters(thread: Pick<ListedThread, "labels" | "projects">, filters: ThreadFilters): boolean {
  const passes = (values: readonly string[], ticked: readonly string[]) => ticked.length === 0 || (values.length === 0 ? ticked.includes(NO_VALUE) : values.some((v) => ticked.includes(v)));
  return passes(thread.labels.map((l) => l.name.toLowerCase()), filters.labels.map((l) => l.toLowerCase())) && passes(thread.projects, filters.projects);
}

/** The label names these threads carry, each once whatever its case (the
 *  first spelling met), sorted. */
export function labelChoices(threads: readonly Pick<ListedThread, "labels">[]): string[] {
  const names = new Map<string, string>();
  for (const thread of threads) {
    for (const label of thread.labels) {
      const key = label.name.toLowerCase();
      if (!names.has(key)) names.set(key, label.name);
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/** The projects these threads' workers ran in, each once, sorted. */
export function projectChoices(threads: readonly Pick<ListedThread, "projects">[]): string[] {
  return [...new Set(threads.flatMap((t) => t.projects))].sort((a, b) => a.localeCompare(b));
}

/** How many of a cell's items fit on its one line: in order, `gap` between
 *  them, and room for the count of the rest (`more` wide, after a gap) once
 *  not all fit, or always when `counted` (there are more items than the cell
 *  may name). At least one of any: it is shown and cut. */
export function fitCount(widths: readonly number[], available: number, { gap, more, counted }: { gap: number; more: number; counted: boolean }): number {
  if (widths.length === 0) return 0;
  const room = available - (counted ? gap + more : 0);
  const all = widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
  if (all <= room) return widths.length;
  const limit = counted ? room : available - gap - more;
  let used = 0;
  let count = 0;
  for (const [index, width] of widths.entries()) {
    const next = used + width + (index > 0 ? gap : 0);
    if (next > limit) break;
    used = next;
    count += 1;
  }
  return Math.max(1, count);
}
