import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { InlineError, LoadingLine, StateAction, StateLink, StateMessage } from "@/components/ViewState";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNow } from "@/hooks/useNow";
import { useProjectsArrival } from "@/hooks/useProjectsArrival";
import { useThreadDots } from "@/hooks/useThreadDots";
import { formatCalendarDate, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { threadHref } from "@/lib/worker-href";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { browseHref } from "@/routes/memory/memory-filters";
import { tasksWithLabelHref } from "@/routes/task-board/task-links";
import { useOpenTask } from "@/routes/task-board/task-open";
import { TaskStatusIcon } from "@/routes/task-board/TaskStatusIcon";
import { threadsForProjectHref, type ListedThread } from "@/routes/threads/thread-list";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore, type Project } from "@/store/projects";
import { useTaskBoardStore } from "@/store/task-board";
import type { CanvasListItemDto } from "@shared/api/canvas";
import type { TaskDto } from "@shared/api/task-board";
import type { ThreadDot } from "@shared/thread-dot";
import { ProjectActionsMenu } from "./ProjectActionsMenu";
import { activeWorkers, countText, projectOpenTasks, projectThreads, workersInProjectDir } from "./project-overview";
import { useProjectReads } from "./project-reads";
import { RestoreButton, SessionMissing } from "./ProjectSession";
import { ProjectWorkers } from "./ProjectWorkers";

/** How many of each list the page shows; the page each links to has them all. */
const THREADS_SHOWN = 5;
const TASKS_SHOWN = 5;

const COLUMN = "@container mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-4 pt-1 pb-8 pointer-coarse:pt-2 md:px-8";
const ROWS = "overflow-hidden rounded-lg border border-border-soft bg-panel";
const ROW = "flex min-h-9 w-full min-w-0 items-center gap-2.5 border-t border-border-soft px-3 py-2 text-left text-[13px] text-foreground first:border-t-0 hover:bg-sel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11";

/**
 * One project from its own point of view (`/projects/<slug>`, the slug its
 * workers' addresses use): its name and folder, a line of counts, its workers,
 * what the agents know of it, its threads and open tasks, its newest reports,
 * each list leading to the page that holds them all.
 */
export function ProjectPage() {
  const { projectSlug = "" } = useParams();
  const project = useProjectsStore((s) => s.bySlug[projectSlug]);
  const arrival = useProjectsArrival();
  const navigate = useNavigate();
  // Archiving it from here: the stream may take the project away before the
  // request answers. It is leaving, not missing; the list replaces it.
  const [leaving, setLeaving] = useState(false);
  // Before the projects arrive, a slug is not yet one that names none.
  if (arrival !== "loaded") {
    return (
      <div className={COLUMN}>
        {arrival === "late" ? (
          <StateMessage title="Couldn't load projects" heading="h1" action={<StateAction onClick={() => window.location.reload()}>Retry</StateAction>}>
            The list of projects hasn't arrived from Mandate. Check that it's running.
          </StateMessage>
        ) : <LoadingLine />}
      </div>
    );
  }
  if (!project) {
    if (leaving) return <div className={COLUMN} />;
    return (
      <div className={COLUMN}>
        <StateMessage title="No such project." heading="h1" action={<StateLink to="/projects">All projects</StateLink>} />
      </div>
    );
  }
  return (
    <ProjectOverview
      project={project}
      onArchiveStart={() => setLeaving(true)}
      onArchiveEnd={(archived) => { if (archived) void navigate("/projects", { replace: true }); else setLeaving(false); }}
    />
  );
}

function ProjectOverview({ project, onArchiveStart, onArchiveEnd }: { project: Project; onArchiveStart: () => void; onArchiveEnd: (archived: boolean) => void }) {
  const open = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  const dots = useThreadDots();
  const tasks = useTaskBoardStore((s) => s.tasks);
  const now = useNow();
  const openTask = useOpenTask();
  const threads = useMemo(() => projectThreads(open.values(), archived, project.name, dots), [open, archived, project.name, dots]);
  const openTasks = useMemo(() => projectOpenTasks(tasks?.values() ?? [], project.name), [tasks, project.name]);
  const working = activeWorkers(project).length;
  const { brief, memories, reports, retry } = useProjectReads(project.id);
  const openCanvas = useOpenCanvas();
  const phone = useIsMobile();

  return (
    <div data-slot="project-page" className={COLUMN}>
      {/* Desktop's band shows a breadcrumb's last part alone: the page says
          where it sits itself, as the terminal page does. A phone's top bar
          draws the whole breadcrumb. */}
      {!phone && (
        <PaneHeaderTitle>
          {/* A breadcrumb, not a heading: the project's name below is the page's h1. */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
            <Link to="/projects" className="shrink-0 text-muted-foreground hover:text-foreground">Projects</Link>
            <span aria-hidden className="text-faint">/</span>
            <span aria-current="page" className="min-w-0 truncate font-semibold text-foreground">{project.name}</span>
          </nav>
        </PaneHeaderTitle>
      )}
      <header data-slot="project-header" className="flex min-w-0 flex-col gap-1">
        <div className="flex min-h-8 min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">{project.name}</h1>
          <SessionMissing project={project} />
          <span className="flex-1" />
          <RestoreButton project={project} />
          <ProjectActionsMenu
            projectId={project.id}
            projectName={project.name}
            workingDir={project.workingDir}
            inProjectWorkers={workersInProjectDir(project)}
            hasTmuxSession={project.tmuxStatus !== "gone"}
            onArchiveStart={onArchiveStart}
            onArchiveEnd={onArchiveEnd}
          />
        </div>
        <p data-slot="project-folder" className="min-w-0 truncate font-mono text-2xs text-faint" title={project.workingDir}>{project.workingDir}</p>
      </header>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <Figure n={working} one="working" many="working" />
        <Figure n={openTasks.length} one="open task" many="open tasks" />
        <Figure n={threads.length} one="thread" many="threads" />
        {/* A count not read, or not readable, is left out rather than guessed. */}
        {memories.state === "read" && <Figure n={memories.value} one="memory" many="memories" />}
        {reports.state === "read" && <Figure n={reports.value.total} one="report" many="reports" />}
      </div>

      <Block name="workers" title="Working now">
        {working > 0 ? <ProjectWorkers project={project} /> : <Empty>No workers right now.</Empty>}
      </Block>

      <Block name="brief" title="What the agents know" link={{ label: "Memory →", to: browseHref({ projectId: project.id }) }}>
        {brief.state === "loading" ? <LoadingLine className="px-1" />
          : brief.state === "failed" ? <InlineError onRetry={retry}>Couldn't load the brief.</InlineError>
          : brief.value ? <Brief text={brief.value} /> : <Empty>No brief yet.</Empty>}
      </Block>

      <div className="grid min-w-0 gap-6 @[44rem]:grid-cols-2">
        {/* Where they all are: Archived once none is open. */}
        <Block name="threads" title="Threads" link={{ label: "All threads →", to: threadsForProjectHref(project.name, threads.length > 0 && threads.every((t) => t.archived) ? "archived" : "active") }}>
          {threads.length > 0 ? (
            <div className={ROWS}>
              {threads.slice(0, THREADS_SHOWN).map((thread) => <ThreadRow key={thread.id} thread={thread} dot={dots.get(thread.id) ?? "idle"} now={now} />)}
            </div>
          ) : <Empty>No threads yet.</Empty>}
        </Block>
        <Block name="tasks" title="Open tasks" link={{ label: "Board →", to: tasksWithLabelHref(project.name) }}>
          {openTasks.length > 0 ? (
            <div className={ROWS}>
              {openTasks.slice(0, TASKS_SHOWN).map((task) => <TaskRow key={task.id} task={task} onOpen={() => openTask(task.id)} />)}
            </div>
          ) : <Empty>No open tasks.</Empty>}
        </Block>
      </div>

      <Block name="reports" title="Recent reports">
        {reports.state === "loading" ? <LoadingLine className="px-1" />
          : reports.state === "failed" ? <InlineError onRetry={retry}>Couldn't load the reports.</InlineError>
          : reports.value.canvases.length > 0 ? (
            <div className={ROWS}>
              {reports.value.canvases.map((canvas) => <ReportRow key={canvas.id} canvas={canvas} now={now} onOpen={() => openCanvas(canvas.id)} />)}
            </div>
          ) : <Empty>No reports yet.</Empty>}
      </Block>
    </div>
  );
}

/** One of the counts under the name: the number, then what it counts. */
function Figure({ n, one, many }: { n: number; one: string; many: string }) {
  const [number, ...words] = countText(n, one, many).split(" ");
  return (
    <span data-slot="project-figure">
      <span className="num font-semibold text-foreground">{number}</span> {words.join(" ")}
    </span>
  );
}

/** A part of the page: its heading, the link to all of it, then what it shows. */
function Block({ name, title, link, children }: { name: string; title: string; link?: { label: string; to: string }; children: ReactNode }) {
  return (
    <section data-slot="project-block" data-block={name} className="flex min-w-0 flex-col gap-1.5">
      {/* 36px on a touch screen: the link's 44px area then stays clear of the list under it. */}
      <div className="flex h-7 items-center gap-2 pointer-coarse:h-9">
        <h2 className="text-xs font-semibold text-foreground">{title}</h2>
        {link && (
          <Link to={link.to} data-slot="project-block-link" className="hit relative ml-auto text-2xs text-muted-foreground hover:text-foreground">
            {link.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** The brief's first lines; where it is cut, it fades out (the Memory page
 *  has the rest). Whether it is cut is measured as a browser lays it out. */
function Brief({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div ref={box} data-slot="project-brief" className="relative max-h-[10lh] overflow-hidden rounded-lg bg-panel px-3.5 py-2.5 text-[13px] text-muted-foreground">
      <MarkdownView text={text} dense />
      {cut && <div aria-hidden data-slot="project-brief-fade" className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-panel to-transparent" />}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p data-slot="project-block-empty" className="px-1 py-1 text-xs text-faint">{children}</p>;
}

/** A thread: its state (none once archived), its title, and when, as the Threads page says it. */
function ThreadRow({ thread, dot, now }: { thread: ListedThread; dot: ThreadDot; now: number }) {
  return (
    <Link to={threadHref(thread.id)} data-slot="project-thread-row" data-thread-id={thread.id} className={ROW}>
      {thread.archived ? <span aria-hidden className="size-2.5 shrink-0" /> : <ThreadStateMark dot={dot} />}
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <span className="num shrink-0 text-2xs text-faint">{thread.archived ? formatCalendarDate(thread.at, now) : formatRelativeTime(thread.at, now)}</span>
    </Link>
  );
}

/** An open task: its status and title; it opens where tasks open from here. */
function TaskRow({ task, onOpen }: { task: TaskDto; onOpen: () => void }) {
  return (
    <button type="button" data-slot="project-task-row" data-task-id={task.id} className={cn(ROW, "cursor-pointer")} onClick={onOpen}>
      <TaskStatusIcon status={task.status} />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
    </button>
  );
}

/** A report: its title and when it last changed; it opens over the page. */
function ReportRow({ canvas, now, onOpen }: { canvas: CanvasListItemDto; now: number; onOpen: () => void }) {
  return (
    <button type="button" data-slot="project-report-row" data-canvas-id={canvas.id} className={cn(ROW, "cursor-pointer")} onClick={onOpen}>
      <span data-slot="project-report-title" className="min-w-0 flex-1 truncate">{canvas.title}</span>
      <span className="num shrink-0 text-2xs text-faint">{formatRelativeTime(canvas.updatedAt, now)}</span>
    </button>
  );
}
