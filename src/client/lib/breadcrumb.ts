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
}

/** Pure: derive a breadcrumb from the current route + project state.
 *  See breadcrumb.test.ts for every supported route pattern.
 *  Unmatched routes fall back to a single segment with the first path part. */
export function buildBreadcrumb({ pathname, bySlug }: BuildBreadcrumbInput): BreadcrumbSegment[] {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return [{ label: "Home", current: true }];
  }

  const head = parts[0];

  if (head === "projects") {
    if (parts.length === 1) {
      // The nav item is "Home"; the band said "Projects" for the same page.
      return [{ label: "Home", current: true }];
    }
    const projectSlug = parts[1] ?? "";
    const project = bySlug[projectSlug];
    const projectLabel = project?.name ?? projectSlug;

    if (parts.length >= 4 && parts[2] === "features") {
      const featureSlug = parts[3] ?? "";
      const feature = findFeatureBySlug(project, featureSlug);
      const featureLabel = feature?.name ?? featureSlug;
      // Via the helper rather than a literal, so a change to the route shape in
      // App.tsx reaches this link. That is a property of this call site alone —
      // the same template is still spelled out inline at several other call
      // sites in the client and once server-side, so the codebase makes no
      // one-definition guarantee to lean on.
      const href = featureHref(projectSlug, featureSlug);

      // Pane subroute (`/.../pane/:paneId`): feature is linkable so the user
      // can pop back to the window detail; the pane segment is the current
      // location. Pane id is decoded once for display (URL params arrive
      // single-encoded; tmux ids like %37 read better than %2537).
      if (parts.length >= 6 && parts[4] === "pane") {
        const featureTerminalHref = `${href}?tab=terminal`;
        const paneSlug = parts[5] ?? "";
        let paneLabel = paneSlug;
        try { paneLabel = decodeURIComponent(paneSlug); } catch { /* keep as-is */ }
        return [
          { label: projectLabel, href: "/projects" },
          { label: featureLabel, href: featureTerminalHref },
          { label: paneLabel, current: true, mono: true }
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
      // linkable so the user can pop back to the layout view; pane id is
      // the current location.
      if (parts.length >= 6 && parts[4] === "pane") {
        const paneSlug = parts[5] ?? "";
        let paneLabel = paneSlug;
        try { paneLabel = decodeURIComponent(paneSlug); } catch { /* keep as-is */ }
        return [
          { label: "sessions", href: "/sessions" },
          { label: sessionName, href: `/sessions/${sessionName}`, mono: true },
          { label: windowName, href: `/sessions/${sessionName}/windows/${windowName}`, mono: true },
          { label: paneLabel, current: true, mono: true }
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
