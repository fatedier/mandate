import { findWorkerBySlug, type Project } from "@/store/projects";
import { workerInThreadHref } from "@/lib/worker-href";

interface BreadcrumbSegment {
  /** Display text for this segment. */
  label: string;
  /** Absolute URL to navigate to when clicked. Undefined for the current
   *  location (industry convention: "you are here" is plain text). */
  href?: string;
  /** Render in the mono font — the label is a machine identifier
   *  (tmux session/window name, pane id, canvas id), not a human name. */
  mono?: boolean;
}

interface BuildBreadcrumbInput {
  pathname: string;
  /** Project lookup by slug (== tmuxSessionName). Pass
   *  `useProjectsStore((s) => s.bySlug)` from React. */
  bySlug: Record<string, Project>;
  /** A manager thread's title by id; pass the thread store's lookup. */
  threadTitle?: (threadId: string) => string | undefined;
}

/** Pure: derive a breadcrumb from the current route + project state.
 *  See breadcrumb.test.ts for every supported route pattern.
 *  Unmatched routes fall back to a single segment with the first path part. */
export function buildBreadcrumb({ pathname, bySlug, threadTitle }: BuildBreadcrumbInput): BreadcrumbSegment[] {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return [{ label: "Home" }];
  }

  const head = parts[0];

  if (head === "home") return [{ label: "Home" }];
  if (head === "projects") {
    // The band matches the nav item.
    if (parts.length === 1) return [{ label: "Projects" }];
    const projectSlug = parts[1] ?? "";
    const project = bySlug[projectSlug];
    const projectLabel = project?.name ?? projectSlug;

    // A worker's terminal (`/projects/:p/workers/:f/pane/:paneId`), the one
    // page under a worker: the worker is linkable so the user can pop back to
    // its Terminal tab in its thread's panel (the projects until they hold
    // the worker); the current location is named Terminal, not by tmux's
    // global pane id (%37 says nothing to a person). Which pane it is shows in
    // the terminal's own bar.
    if (parts.length >= 6 && parts[2] === "workers" && parts[4] === "pane") {
      const worker = findWorkerBySlug(project, parts[3] ?? "");
      // A worker the projects don't hold reads Worker, as an unknown thread
      // reads Thread.
      const workerLabel = worker?.name ?? "Worker";
      const workerTerminalHref = worker?.ownerThreadId ? workerInThreadHref(worker.ownerThreadId, worker.id, "terminal") : "/projects";
      return [
        // A project the projects hold opens its page; one they don't, the list.
        { label: projectLabel, href: project ? `/projects/${encodeURIComponent(projectSlug)}` : "/projects" },
        { label: workerLabel, href: workerTerminalHref },
        { label: "Terminal" }
      ];
    }
    // A project's page, and any other /projects/<slug>/…: under Projects.
    return [{ label: "Projects", href: "/projects" }, { label: projectLabel }];
  }

  if (head === "terminals") {
    if (parts.length === 1) return [{ label: "Terminals" }];
    // A pane's terminal, or a window's layout: under Terminals.
    return [{ label: "Terminals", href: "/terminals" }, { label: parts[1] === "window" ? "Window" : "Terminal" }];
  }
  if (head === "threads") {
    if (!parts[1]) return [{ label: "New thread" }];
    return [{ label: threadTitle?.(decodeURIComponent(parts[1])) ?? "Thread" }];
  }
  if (head === "activity") return [{ label: "Activity" }];
  if (head === "duty") return [{ label: "On duty" }];
  if (head === "tasks") return [{ label: "Tasks" }];
  if (head === "notes") return [{ label: "Notes" }];
  if (head === "calendar") return [{ label: "Calendar" }];
  if (head === "memory") return [{ label: "Memory" }];
  if (head === "canvas" && parts.length > 1) {
    return [
      { label: "Canvas" },
      { label: parts[1] ?? "detail", mono: true }
    ];
  }
  if (head === "settings") return [{ label: "Settings" }];

  return [{ label: head ?? "home" }];
}
