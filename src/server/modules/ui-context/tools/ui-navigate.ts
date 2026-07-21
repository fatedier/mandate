import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { ProjectRow, ProjectsStore } from "../../projects/projects-store.js";
import type { FeatureRow, FeaturesStore } from "../../features/features-store.js";
import type { TmuxSnapshot, TmuxSnapshotSession, TmuxSnapshotWindow } from "../../../platform/tmux/tmux-types.js";
import {
  tmuxHasSession,
  tmuxListSessions,
  tmuxListWindows,
  type TmuxClient
} from "../../../platform/tmux/tmux.js";
import { UI_ACTIONS } from "../../../../shared/api-contracts.js";

const params = z.object({
  path: z.string().regex(/^\/[a-zA-Z0-9/_:%.\-?=&]*$/, "must be a Mandate-internal path starting with /").optional().describe(
    "Fallback raw Mandate-internal path. Prefer route + ids/names for voice or ambiguous requests."
  ),
  route: z.enum([
    "home",
    "projects",
    "sessions",
    "activity",
    "settings",
    "feature",
    "feature_pane",
    "session",
    "window",
    "window_pane"
  ]).optional().describe(
    "Structured destination. Prefer this over path so Mandate can resolve and validate project/feature/session names."
  ),
  projectId: z.string().optional(),
  projectSlug: z.string().optional().describe("Project slug from list_projects, or a project name if voice transcription is approximate."),
  projectName: z.string().optional(),
  featureId: z.string().optional(),
  featureSlug: z.string().optional().describe("Feature slug from list_features, or a feature name if voice transcription is approximate."),
  featureName: z.string().optional(),
  paneId: z.string().optional(),
  sessionName: z.string().optional(),
  windowName: z.string().optional()
}).refine((value) => Boolean(value.path || value.route), {
  message: "either path or route is required"
});

type NavigateResult = { ok: true } | { error: string };

/** Static routes that take no params. */
const STATIC_ROUTES = new Set([
  "/", "/projects", "/sessions", "/activity", "/settings"
]);

/** Strip a possible "?query=foo&bar=baz" tail before pattern-matching the
 *  pathname. Query params are preserved on the way to the client. */
function splitPath(input: string): { pathname: string; query: string } {
  const q = input.indexOf("?");
  if (q < 0) return { pathname: input, query: "" };
  return { pathname: input.slice(0, q), query: input.slice(q) };
}

export interface UiNavigateDeps {
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  getSnapshot?: () => TmuxSnapshot | null;
  tmuxClient?: TmuxClient;
  emit: (action: string, payload: unknown) => void;
}

export function buildUiNavigateTool(deps: UiNavigateDeps): ToolDefinition<z.infer<typeof params>, NavigateResult> {
  return {
    name: "ui_navigate",
    description:
      "Navigate the user's browser to a Mandate page. Prefer structured route fields over raw path, especially for voice sessions, because Mandate can resolve and validate names before navigating. " +
      "Load the 'ui-routes' skill first to see what destinations exist and where ids/slugs come from. " +
      "Returns an error (and does NOT navigate) when the path doesn't match any known route or when a referenced project/feature doesn't exist — in which case the error message tells you the right field to use.",
    parameters: params,
    approval: "never",
    handler: async (args) => {
      const path = args.route ? resolveStructuredPath(args, deps) : args.path;
      if (typeof path !== "string") return { error: path?.error ?? "path or route is required" };
      const { pathname, query } = splitPath(path);
      const err = validatePath(pathname, deps);
      if (err) return { error: err };
      deps.emit(UI_ACTIONS.navigate, { path: `${canonicalizePathname(pathname)}${query}` });
      return { ok: true };
    }
  };
}

function safeDecodeURIComponent(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function canonicalizeSegment(segment: string): string {
  if (segment === "") return segment;
  // Tmux pane ids are literal strings like "%27". In a browser path that
  // leading "%" must be encoded as "%25", otherwise React Router decodes
  // "%27" into an apostrophe before TerminalPage sees it.
  if (/^%25\d+$/.test(segment)) return segment;
  if (/^%\d+$/.test(segment)) return encodeURIComponent(segment);
  const decoded = safeDecodeURIComponent(segment);
  if (/^%\d+$/.test(decoded)) return encodeURIComponent(decoded);
  return encodeURIComponent(decoded);
}

function canonicalizePathname(pathname: string): string {
  return pathname.split("/").map(canonicalizeSegment).join("/");
}

function validatePath(pathname: string, deps: UiNavigateDeps): string | null {
  if (STATIC_ROUTES.has(pathname)) return null;
  if (/^\/canvas\/[^/]+$/.test(pathname)) return null;

  // /projects/<slug>/features/<slug>[/pane/<paneId>]
  const featureMatch = pathname.match(/^\/projects\/([^/]+)\/features\/([^/]+)(?:\/pane\/([^/]+))?$/);
  if (featureMatch) {
    const projectSlug = decodeURIComponent(featureMatch[1]!);
    const featureSlug = decodeURIComponent(featureMatch[2]!);
    const projects = deps.projectsStore.listActive();
    const project = projects.find((p) => p.tmuxSessionName === projectSlug);
    if (!project) {
      const known = projects.map((p) => p.tmuxSessionName).join(", ") || "(none)";
      return `Project slug '${projectSlug}' not found. Use the 'slug' field from list_projects (NOT id or name). Known project slugs: ${known}`;
    }
    const features = deps.featuresStore.listActiveByProject(project.id);
    const feature = features.find((f) => f.tmuxWindowName === featureSlug);
    if (!feature) {
      const known = features.map((f) => f.tmuxWindowName).join(", ") || "(none)";
      return `Feature slug '${featureSlug}' not found in project '${projectSlug}'. Use the 'slug' field from list_features (NOT id or name). Known feature slugs in this project: ${known}`;
    }
    return null;
  }

  // /sessions/<sessionName>[/windows/<windowName>]
  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)(?:\/windows\/([^/]+))?$/);
  if (sessionMatch) {
    const sessionName = decodeURIComponent(sessionMatch[1]!);
    const windowName = sessionMatch[2] ? decodeURIComponent(sessionMatch[2]) : null;
    const liveErr = validateLiveTmuxTarget(sessionName, windowName, deps);
    if (liveErr !== undefined) return liveErr;
    const snapshot = deps.getSnapshot?.() ?? null;
    if (!snapshot) return null;
    const session = findSession(snapshot, sessionName);
    if (!session) {
      const known = snapshot.sessions.map((s) => s.sessionName).join(", ") || "(none)";
      return `Session '${sessionName}' not found. Known sessions: ${known}`;
    }
    if (!windowName) return null;
    if (session.windows.length === 0) return null;
    if (!findWindow(session, windowName)) {
      const known = session.windows.map((w) => w.windowName).join(", ") || "(none)";
      return `Window '${windowName}' not found in session '${session.sessionName}'. Known windows: ${known}`;
    }
    return null;
  }

  const sessionPaneMatch = pathname.match(/^\/sessions\/([^/]+)\/windows\/([^/]+)\/pane\/([^/]+)$/);
  if (sessionPaneMatch) {
    const sessionName = decodeURIComponent(sessionPaneMatch[1]!);
    const windowName = decodeURIComponent(sessionPaneMatch[2]!);
    const liveErr = validateLiveTmuxTarget(sessionName, windowName, deps);
    if (liveErr !== undefined) return liveErr;
    const snapshot = deps.getSnapshot?.() ?? null;
    if (!snapshot) return null;
    const session = findSession(snapshot, sessionName);
    if (!session) {
      const known = snapshot.sessions.map((s) => s.sessionName).join(", ") || "(none)";
      return `Session '${sessionName}' not found. Known sessions: ${known}`;
    }
    if (session.windows.length === 0) return null;
    if (!findWindow(session, windowName)) {
      const known = session.windows.map((w) => w.windowName).join(", ") || "(none)";
      return `Window '${windowName}' not found in session '${session.sessionName}'. Known windows: ${known}`;
    }
    return null;
  }

  return (
    `Path '${pathname}' doesn't match any Mandate route. Load the 'ui-routes' skill (call skill with name='ui-routes') to see the valid path patterns.`
  );
}

function resolveStructuredPath(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps
): string | { error: string } {
  switch (args.route) {
    case "home": return "/";
    case "projects": return "/projects";
    case "sessions": return "/sessions";
    case "activity": return "/activity";
    case "settings": return "/settings";
    case "feature":
    case "feature_pane": {
      const resolved = resolveFeatureDestination(args, deps);
      if ("error" in resolved) return resolved;
      const base = `/projects/${encodeURIComponent(resolved.project.tmuxSessionName)}/features/${encodeURIComponent(resolved.feature.tmuxWindowName)}`;
      if (args.route === "feature") return base;
      if (!args.paneId) return { error: "paneId is required for route='feature_pane'" };
      return `${base}/pane/${args.paneId}`;
    }
    case "session": {
      const resolved = resolveSession(args, deps);
      if ("error" in resolved) return resolved;
      return `/sessions/${encodeURIComponent(resolved.session.sessionName)}`;
    }
    case "window": {
      return resolveSessionWindowPath(args, deps);
    }
    case "window_pane": {
      return resolveSessionWindowPanePath(args, deps);
    }
    default:
      return { error: "route is required when path is not provided" };
  }
}

function resolveFeatureDestination(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps
): { project: ProjectRow; feature: FeatureRow } | { error: string } {
  const feature = resolveFeature(args, deps);
  if ("error" in feature) return feature;
  const project = deps.projectsStore.getById(feature.feature.projectId);
  if (!project || project.archivedAt) {
    return { error: `Project for feature '${feature.feature.name}' is missing or archived.` };
  }
  return { project, feature: feature.feature };
}

function resolveFeature(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps
): { feature: FeatureRow } | { error: string } {
  if (args.featureId) {
    const feature = deps.featuresStore.getById(args.featureId);
    if (!feature || feature.archivedAt) return { error: `Feature id '${args.featureId}' not found.` };
    return { feature };
  }

  const project = resolveProject(args, deps);
  if ("error" in project && hasProjectSelector(args)) return project;
  const candidates = "error" in project
    ? deps.featuresStore.listAllActive()
    : deps.featuresStore.listActiveByProject(project.project.id);
  const needle = args.featureSlug ?? args.featureName;
  if (!needle) {
    return { error: "featureId, featureSlug, or featureName is required for feature navigation." };
  }
  const matches = candidates.filter((f) => matchesName(needle, [f.tmuxWindowName, f.name]));
  if (matches.length === 1) return { feature: matches[0]! };
  if (matches.length > 1) {
    return { error: `Feature '${needle}' is ambiguous. Matching features: ${matches.map((f) => `${f.name} (${f.tmuxWindowName})`).join(", ")}` };
  }
  const known = candidates.map((f) => `${f.name} (${f.tmuxWindowName})`).join(", ") || "(none)";
  return { error: `Feature '${needle}' not found. Known features: ${known}` };
}

function hasProjectSelector(args: z.infer<typeof params>): boolean {
  return Boolean(args.projectId || args.projectSlug || args.projectName);
}

function resolveProject(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps
): { project: ProjectRow } | { error: string } {
  if (args.projectId) {
    const project = deps.projectsStore.getById(args.projectId);
    if (!project || project.archivedAt) return { error: `Project id '${args.projectId}' not found.` };
    return { project };
  }
  const needle = args.projectSlug ?? args.projectName;
  if (!needle) return { error: "projectId, projectSlug, or projectName is required." };
  const projects = deps.projectsStore.listActive();
  const matches = projects.filter((p) => matchesName(needle, [p.tmuxSessionName, p.name]));
  if (matches.length === 1) return { project: matches[0]! };
  if (matches.length > 1) {
    return { error: `Project '${needle}' is ambiguous. Matching projects: ${matches.map((p) => `${p.name} (${p.tmuxSessionName})`).join(", ")}` };
  }
  const known = projects.map((p) => `${p.name} (${p.tmuxSessionName})`).join(", ") || "(none)";
  return { error: `Project '${needle}' not found. Known projects: ${known}` };
}

function resolveSession(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps
): { session: TmuxSnapshotSession } | { error: string } {
  const liveSessionName = resolveLiveSessionName(args.sessionName, deps);
  if (typeof liveSessionName === "string") {
    return { session: placeholderSession(liveSessionName) };
  }
  if (liveSessionName) return liveSessionName;

  const snapshot = deps.getSnapshot?.() ?? null;
  if (!snapshot) {
    if (!args.sessionName) return { error: "sessionName is required for route='session'" };
    return { session: placeholderSession(args.sessionName) };
  }
  if (!args.sessionName) return { error: "sessionName is required for route='session'" };
  const session = findSession(snapshot, args.sessionName);
  if (session) return { session };
  const known = snapshot.sessions.map((s) => s.sessionName).join(", ") || "(none)";
  return { error: `Session '${args.sessionName}' not found. Known sessions: ${known}` };
}

function placeholderSession(sessionName: string): TmuxSnapshotSession {
  return {
    sessionName,
    sessionWindows: 0,
    sessionAttached: 0,
    created: "",
    activeClient: null,
    windows: []
  };
}

function resolveSessionWindowPath(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps,
  routeName = "window"
): string | { error: string } {
  if (!args.windowName) return { error: `windowName is required for route='${routeName}'` };
  const live = resolveLiveWindowPath(args, deps, routeName);
  if (live !== undefined) return live;
  const sessionResult = resolveSession(args, deps);
  if ("error" in sessionResult) return sessionResult;
  if (sessionResult.session.windows.length === 0) {
    return `/sessions/${encodeURIComponent(sessionResult.session.sessionName)}/windows/${encodeURIComponent(args.windowName)}`;
  }
  const window = findWindow(sessionResult.session, args.windowName);
  if (window) {
    return `/sessions/${encodeURIComponent(sessionResult.session.sessionName)}/windows/${encodeURIComponent(window.windowName)}`;
  }
  const known = sessionResult.session.windows.map((w) => w.windowName).join(", ") || "(none)";
  return { error: `Window '${args.windowName}' not found in session '${sessionResult.session.sessionName}'. Known windows: ${known}` };
}

function resolveSessionWindowPanePath(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps
): string | { error: string } {
  if (!args.paneId) return { error: "paneId is required for route='window_pane'" };
  const windowPath = resolveSessionWindowPath(args, deps, "window_pane");
  if (typeof windowPath !== "string") return windowPath;
  return `${windowPath}/pane/${args.paneId}`;
}

function findSession(snapshot: TmuxSnapshot, name: string): TmuxSnapshotSession | null {
  return snapshot.sessions.find((s) => matchesName(name, [s.sessionName])) ?? null;
}

function findWindow(session: TmuxSnapshotSession, name: string): TmuxSnapshotWindow | null {
  return session.windows.find((w) => matchesName(name, [w.windowName, String(w.windowIndex)])) ?? null;
}

function validateLiveTmuxTarget(
  sessionName: string,
  windowName: string | null,
  deps: UiNavigateDeps
): string | null | undefined {
  if (!deps.tmuxClient) return undefined;
  const session = findLiveSessionName(sessionName, deps);
  if (!session) {
    const known = tmuxListSessions(deps.tmuxClient).join(", ") || "(none)";
    return `Session '${sessionName}' not found. Known sessions: ${known}`;
  }
  if (!windowName) return null;
  const windows = tmuxListWindows(session, deps.tmuxClient);
  const window = findName(windowName, windows);
  if (!window) {
    const known = windows.join(", ") || "(none)";
    return `Window '${windowName}' not found in session '${session}'. Known windows: ${known}`;
  }
  return null;
}

function resolveLiveSessionName(
  sessionName: string | undefined,
  deps: UiNavigateDeps
): string | { error: string } | undefined {
  if (!deps.tmuxClient) return undefined;
  if (!sessionName) return { error: "sessionName is required for route='session'" };
  const session = findLiveSessionName(sessionName, deps);
  if (session) return session;
  const known = tmuxListSessions(deps.tmuxClient).join(", ") || "(none)";
  return { error: `Session '${sessionName}' not found. Known sessions: ${known}` };
}

function resolveLiveWindowPath(
  args: z.infer<typeof params>,
  deps: UiNavigateDeps,
  routeName = "window"
): string | { error: string } | undefined {
  if (!deps.tmuxClient) return undefined;
  if (!args.sessionName) return { error: `sessionName is required for route='${routeName}'` };
  if (!args.windowName) return { error: `windowName is required for route='${routeName}'` };
  const session = findLiveSessionName(args.sessionName, deps);
  if (!session) {
    const known = tmuxListSessions(deps.tmuxClient).join(", ") || "(none)";
    return { error: `Session '${args.sessionName}' not found. Known sessions: ${known}` };
  }
  const windows = tmuxListWindows(session, deps.tmuxClient);
  const window = findName(args.windowName, windows);
  if (!window) {
    const known = windows.join(", ") || "(none)";
    return { error: `Window '${args.windowName}' not found in session '${session}'. Known windows: ${known}` };
  }
  return `/sessions/${encodeURIComponent(session)}/windows/${encodeURIComponent(window)}`;
}

function findLiveSessionName(name: string, deps: UiNavigateDeps): string | null {
  const sessions = deps.tmuxClient ? tmuxListSessions(deps.tmuxClient) : [];
  const matched = findName(name, sessions);
  if (matched) return matched;
  if (deps.tmuxClient && tmuxHasSession(name, deps.tmuxClient)) return name;
  return null;
}

function findName(input: string, candidates: string[]): string | null {
  return candidates.find((candidate) => candidate === input)
    ?? candidates.find((candidate) => matchesName(input, [candidate]))
    ?? null;
}

function matchesName(input: string, candidates: string[]): boolean {
  const needle = normalizeForMatch(input);
  return candidates.some((candidate) => normalizeForMatch(candidate) === needle);
}

function normalizeForMatch(value: string): string {
  return safeDecodeURIComponent(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}
