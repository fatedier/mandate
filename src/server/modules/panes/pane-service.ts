import type { ProjectsStore } from "../projects/projects-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import { type TmuxClient, tmuxKillPane, tmuxSplitPane } from "../../platform/tmux/tmux.js";
import { listPaneProcesses } from "../../platform/tmux/tmux-state.js";
import type { RawTmuxPane, RawTmuxState } from "../../platform/tmux/tmux-types.js";
import type { PaneLookupDto, PaneSplitDirection, PaneKillResponse } from "../../../shared/api-contracts.js";
import type { PaneMetadataStore } from "./pane-metadata-store.js";

export interface PaneServiceDeps {
  projects: ProjectsStore;
  workers: WorkersStore;
  tmuxClient: TmuxClient;
  paneMetadata?: PaneMetadataStore;
  getRawState: () => RawTmuxState | null;
  refreshWindows: (windowIds: string[]) => void;
}

export class PaneService {
  constructor(private readonly deps: PaneServiceDeps) {}

  async getPane(paneId: string): Promise<PaneLookupDto | null> {
    const raw = this.deps.getRawState();
    const dto = buildPaneLookup(raw, paneId, this.projectIdsBySession());
    const pane = raw?.panes.find((candidate) => candidate.paneId === paneId);
    // The pane's processes are read now: the poll reads them only in the
    // windows Mandate monitors, and even there can be seconds behind a
    // program just started, which is when a terminal asks. A failed read
    // falls back to what the poll saw.
    if (dto && pane) {
      const processes = await listPaneProcesses(pane.paneTty, this.deps.tmuxClient);
      const current = processes.length > 0 ? processes : pane.processes;
      dto.foregroundProcesses = current.filter((process) => process.state.includes("+")).map(({ command }) => ({ command }));
    }
    return dto;
  }

  async splitPane(paneId: string, direction: PaneSplitDirection) {
    const pane = this.rawPaneForPane(paneId);
    const result = await tmuxSplitPane(paneId, direction, this.deps.tmuxClient, {
      cwd: pane ? this.workerCwdForPane(pane) : null
    });
    if (pane?.windowId) this.deps.refreshWindows([pane.windowId]);
    return result;
  }

  async killPane(paneId: string): Promise<PaneKillResponse> {
    const windowId = this.windowIdForPane(paneId);
    const pane = this.rawPaneForPane(paneId);
    await tmuxKillPane(paneId, this.deps.tmuxClient);
    if (pane) this.deps.paneMetadata?.delete(paneId);
    if (windowId) this.deps.refreshWindows([windowId]);
    return { ok: true };
  }

  private projectIdsBySession(): Map<string, string> {
    const projectsBySession = new Map<string, string>();
    for (const project of this.deps.projects.listActive()) {
      projectsBySession.set(project.tmuxSessionName, project.id);
    }
    return projectsBySession;
  }

  private windowIdForPane(paneId: string): string | null {
    return this.rawPaneForPane(paneId)?.windowId ?? null;
  }

  private rawPaneForPane(paneId: string): RawTmuxPane | null {
    return this.deps.getRawState()?.panes.find((p) => p.paneId === paneId) ?? null;
  }

  private workerCwdForPane(pane: RawTmuxPane): string | null {
    const project = this.deps.projects.getActiveByTmuxSessionName(pane.sessionName);
    if (!project) return null;
    const worker = this.workerForPane(pane);
    if (!worker) return null;
    return worker.worktreePath ?? project.workingDir;
  }

  private workerForPane(pane: RawTmuxPane) {
    const project = this.deps.projects.getActiveByTmuxSessionName(pane.sessionName);
    if (!project) return null;
    return this.deps.workers
      .listActiveByProject(project.id)
      .find((row) => row.tmuxWindowName === pane.windowName) ?? null;
  }
}

export function buildPaneLookup(
  raw: RawTmuxState | null,
  paneId: string,
  projectsBySession: Map<string, string>
): PaneLookupDto | null {
  const rawPanes = raw?.panes ?? [];
  const pane = rawPanes.find((p) => p.paneId === paneId);
  if (!pane) return null;
  return {
    paneId: pane.paneId,
    sessionName: pane.sessionName,
    windowName: pane.windowName,
    windowId: pane.windowId,
    windowIndex: Number(pane.windowIndex ?? 0),
    paneIndex: Number(pane.paneIndex ?? 0),
    active: Boolean(pane.paneActive),
    currentCommand: pane.currentCommand ?? "",
    pid: Number(pane.panePid ?? 0),
    currentPath: pane.currentPath ?? "",
    paneWidth: Number(pane.paneWidth ?? 0),
    paneHeight: Number(pane.paneHeight ?? 0),
    projectId: projectsBySession.get(pane.sessionName) ?? null,
    foregroundProcesses: (pane.foregroundProcesses ?? []).map(({ command }) => ({ command })),
    ...(pane.metadata ? { metadata: pane.metadata } : {})
  };
}
