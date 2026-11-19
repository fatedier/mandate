import { useMemo } from "react";
import { Link } from "react-router";
import { useNow } from "@/hooks/useNow";
import { formatRelativeTime } from "@/lib/format";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { Project } from "@/store/projects";
import { useTaskBoardStore } from "@/store/task-board";
import { ProjectActionsMenu, type ProjectOrdering } from "./ProjectActionsMenu";
import { activeWorkers, countText, projectOpenTasks, workersInProjectDir } from "./project-overview";
import { RestoreButton, SessionMissing } from "./ProjectSession";

/** When the project's threads were last active, open and archived (an
 *  archive is not activity); null with none. */
function useLastActivity(projectName: string): string | null {
  const open = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  return useMemo(() => {
    let last: string | null = null;
    for (const thread of open.values()) if (thread.projects.includes(projectName) && (!last || thread.lastActivityAt > last)) last = thread.lastActivityAt;
    for (const thread of archived) if (thread.projects.includes(projectName) && (!last || thread.lastActivityAt > last)) last = thread.lastActivityAt;
    return last;
  }, [open, archived, projectName]);
}

/**
 * A project on the Projects page: its name (the link to its page, over the
 * whole row) and folder, how many workers it has, its open tasks, when its
 * threads were last active; its session warning, Restore and ⋯ menu above
 * the link. The facts sit beside the name where the list has room, under
 * the folder where it has not.
 */
export function ProjectRow({ project, ordering }: { project: Project; ordering: ProjectOrdering }) {
  const tasks = useTaskBoardStore((s) => s.tasks);
  const openTasks = useMemo(() => projectOpenTasks(tasks?.values() ?? [], project.name).length, [tasks, project.name]);
  const working = activeWorkers(project).length;
  const last = useLastActivity(project.name);
  const now = useNow();
  return (
    <li data-slot="project-row" data-project-id={project.id} className="relative isolate flex min-w-0 items-center gap-3 border-t border-border-soft px-3 py-2.5 transition-colors first:border-t-0 hover:bg-sel">
      <div className="flex min-w-0 flex-1 flex-col gap-1 @[44rem]:flex-row @[44rem]:items-center @[44rem]:gap-4">
        <div className="flex min-w-0 flex-col @[44rem]:flex-1">
          <Link
            to={`/projects/${encodeURIComponent(project.tmuxSessionName)}`}
            data-slot="project-row-name"
            // The link covers the folder below: its title names it whole.
            title={project.workingDir}
            // Over the whole row: the menu and Restore sit above it.
            className="min-w-0 truncate text-[13px] font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:ring-1 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {project.name}
          </Link>
          <span data-slot="project-row-folder" className="min-w-0 truncate font-mono text-2xs text-faint">{project.workingDir}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
          <span data-slot="project-row-fact">{working > 0 ? countText(working, "working", "working") : "No workers"}</span>
          <span data-slot="project-row-fact">{openTasks > 0 ? countText(openTasks, "open task", "open tasks") : "No open tasks"}</span>
          {last && <span data-slot="project-row-fact" className="num text-faint">{formatRelativeTime(last, now)}</span>}
        </div>
      </div>
      {/* 8px apart: on a touch screen Restore's and ⋯'s 44px areas then meet without overlapping. */}
      <div className="relative z-10 flex shrink-0 items-center gap-2">
        <SessionMissing project={project} />
        <RestoreButton project={project} />
        <ProjectActionsMenu
          projectId={project.id}
          projectName={project.name}
          workingDir={project.workingDir}
          inProjectWorkers={workersInProjectDir(project)}
          hasTmuxSession={project.tmuxStatus !== "gone"}
          ordering={ordering}
        />
      </div>
    </li>
  );
}
