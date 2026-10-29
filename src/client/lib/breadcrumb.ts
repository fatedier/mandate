import { findFeatureBySlug, type Project } from "@/store/projects";
import { featureHref } from "@/lib/feature-href";

interface BreadcrumbSegment {
  /** Display text for this segment. */
  label: string;
  /** Absolute URL to navigate to when clicked. Undefined for the current
   *  location (industry convention: "you are here" is plain text). */
  href?: string;
  /** True for the last segment. UI uses this to apply current-page styling
   *  and `aria-current="page"`. */
  current?: boolean;
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
    return [{ label: "Home", current: true }];
  }

  const head = parts[0];

  if (head === "home") return [{ label: "Home", current: true }];
  if (head === "projects") {
    // The band matches the nav item.
    if (parts.length === 1) return [{ label: "Projects", current: true }];
    const projectSlug = parts[1] ?? "";
    const project = bySlug[projectSlug];
    const projectLabel = project?.name ?? projectSlug;

    if (parts.length >= 4 && parts[2] === "features") {
      const featureSlug = parts[3] ?? "";
      const feature = findFeatureBySlug(project, featureSlug);
      // A worker the projects don't hold reads Worker, as an unknown thread
      // reads Thread: the URL's slug ("does_not_exist") named the page above
      // "Worker not found".
      const featureLabel = feature?.name ?? "Worker";
      // Via the helper rather than a literal, so a change to the route shape in
      // App.tsx reaches this link. That is a property of this call site alone —
      // the same template is still spelled out inline at several other call
      // sites in the client and once server-side, so the codebase makes no
      // one-definition guarantee to lean on.
      const href = featureHref(projectSlug, featureSlug);

      // Pane subroute (`/.../pane/:paneId`): feature is linkable so the user
      // can pop back to the window detail; the current location is named
      // Terminal, not by tmux's global pane id (%37 says nothing to a person).
      // Which pane it is shows in the terminal's own bar.
      if (parts.length >= 6 && parts[4] === "pane") {
        const featureTerminalHref = `${href}?tab=terminal`;
        return [
          { label: projectLabel, href: "/projects" },
          { label: featureLabel, href: featureTerminalHref },
          { label: "Terminal", current: true }
        ];
      }

      return [
        { label: projectLabel, href: "/projects" },
        { label: featureLabel, current: true }
      ];
    }
    // /projects/<slug> with no /features — uncommon; show project as current.
    return [{ label: projectLabel, current: true }];
  }

  if (head === "sessions") {
    if (parts.length === 1) return [{ label: "Sessions", current: true }];
    const sessionName = parts[1] ?? "";
    if (parts.length >= 4 && parts[2] === "windows") {
      const windowName = parts[3] ?? "";
      // Pane subroute: /sessions/:s/windows/:w/pane/:p — window becomes
      // linkable so the user can pop back to the layout view; the current
      // location is Terminal, as on a feature's pane.
      if (parts.length >= 6 && parts[4] === "pane") {
        return [
          { label: "sessions", href: "/sessions" },
          { label: sessionName, href: `/sessions/${sessionName}`, mono: true },
          { label: windowName, href: `/sessions/${sessionName}/windows/${windowName}`, mono: true },
          { label: "Terminal", current: true }
        ];
      }
      return [
        { label: "sessions", href: "/sessions" },
        { label: sessionName, href: `/sessions/${sessionName}`, mono: true },
        { label: windowName, current: true, mono: true }
      ];
    }
    return [
      { label: "sessions", href: "/sessions" },
      { label: sessionName, current: true, mono: true }
    ];
  }
  if (head === "threads") {
    if (!parts[1]) return [{ label: "New thread", current: true }];
    return [{ label: threadTitle?.(decodeURIComponent(parts[1])) ?? "Thread", current: true }];
  }
  if (head === "activity") return [{ label: "Activity", current: true }];
  if (head === "memory") return [{ label: "Memory", current: true }];
  if (head === "canvas" && parts.length > 1) {
    return [
      { label: "Canvas" },
      { label: parts[1] ?? "detail", current: true, mono: true }
    ];
  }
  if (head === "settings") return [{ label: "Settings", current: true }];

  return [{ label: head ?? "home", current: true }];
}
