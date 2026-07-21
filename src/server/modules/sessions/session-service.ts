import type { ProjectsStore } from "../projects/projects-store.js";
import {
  type TmuxClient,
  capturePanePreview,
  tmuxListSessionsWithWindows
} from "../../platform/tmux/tmux.js";
import type { RawTmuxPane, RawTmuxState } from "../../platform/tmux/tmux-types.js";
import type {
  SessionDto,
  SessionPaneDto,
  SessionWindowDto,
  WindowDetailDto
} from "../../../shared/api-contracts.js";

export interface SessionsApiDeps {
  projects: ProjectsStore;
  tmuxClient: TmuxClient;
  /** Latest raw tmux poll result. Used to enrich sessions with windows + panes
   *  beyond what `tmuxListSessionsWithWindows` (name-only) returns. */
  getRawState: () => RawTmuxState | null;
}

export type { SessionDto, WindowDetailDto } from "../../../shared/api-contracts.js";

export class SessionService {
  constructor(private readonly deps: SessionsApiDeps) {}

  listSessions(): SessionDto[] {
    const sessions = tmuxListSessionsWithWindows(this.deps.tmuxClient);
    return buildSessionsDto(sessions, this.deps.getRawState(), this.projectsBySession());
  }

  async getWindow(sessionName: string, windowName: string): Promise<WindowDetailDto | null> {
    const raw = this.deps.getRawState();
    if (!raw) return null;

    const window = raw.windows.find((w) => w.sessionName === sessionName && w.windowName === windowName);
    if (!window) return null;

    const panes = raw.panes.filter((p) => p.sessionName === sessionName && p.windowId === window.windowId);
    const previews = await Promise.all(
      panes.map((p: RawTmuxPane) => capturePanePreview(p.paneId, 6, this.deps.tmuxClient).catch(() => ""))
    );

    return {
      sessionName,
      name: window.windowName,
      windowId: window.windowId,
      index: Number(window.windowIndex ?? 0),
      active: Boolean(window.windowActive),
      windowLayout: window.windowLayout ?? "",
      panes: panes.map((p, i: number) => ({
        paneId: p.paneId,
        index: Number(p.paneIndex ?? 0),
        active: Boolean(p.paneActive),
        currentCommand: p.currentCommand ?? "",
        currentPath: p.currentPath ?? "",
        ...(p.metadata ? { metadata: p.metadata } : {}),
        preview: previews[i] ?? ""
      }))
    };
  }

  hasRawState(): boolean {
    return Boolean(this.deps.getRawState());
  }

  private projectsBySession(): Map<string, { id: string; name: string }> {
    const projectsBySession = new Map<string, { id: string; name: string }>();
    for (const project of this.deps.projects.listActive()) {
      projectsBySession.set(project.tmuxSessionName, { id: project.id, name: project.name });
    }
    return projectsBySession;
  }

}

export function buildSessionsDto(
  sessions: Array<{ name: string; windows: string[] }>,
  raw: RawTmuxState | null,
  projectsBySession: Map<string, { id: string; name: string }>
): SessionDto[] {
  const rawWindows = raw?.windows ?? [];
  const rawPanes = raw?.panes ?? [];

  return sessions.map((s) => {
    const owner = projectsBySession.get(s.name);
    const windowsForSession = rawWindows.filter((w) => w.sessionName === s.name);

    // Fall back to name-only windows if the raw poll hasn't caught up yet
    // (immediately after server start, before the first tmux poll completes).
    const windows: SessionWindowDto[] = windowsForSession.length > 0
      ? windowsForSession.map((w) => ({
          name: w.windowName,
          windowId: w.windowId,
          index: Number(w.windowIndex ?? 0),
          active: Boolean(w.windowActive),
          panes: rawPanes
            .filter((p) => p.sessionName === s.name && p.windowId === w.windowId)
            .map((p): SessionPaneDto => ({
              paneId: p.paneId,
              index: Number(p.paneIndex ?? 0),
              active: Boolean(p.paneActive),
              currentCommand: p.currentCommand ?? "",
              currentPath: p.currentPath ?? "",
              ...(p.metadata ? { metadata: p.metadata } : {})
            }))
        }))
      : s.windows.map((name) => ({
          name,
          windowId: "",
          index: 0,
          active: false,
          panes: []
        }));

    return {
      name: s.name,
      windows,
      ownership: owner ? "managed" as const : "unmanaged" as const,
      projectId: owner?.id ?? null,
      projectName: owner?.name ?? null
    };
  });
}
