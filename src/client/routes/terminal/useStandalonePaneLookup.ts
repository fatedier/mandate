import { useEffect, useState } from "react";
import { api } from "@/lib/api-paths";
import type { SnapshotPane, SnapshotWindow } from "@/lib/snapshot-types";
import type { PaneByIdResponse, PaneLookupDto } from "@shared/api-contracts";
import { errorText } from "@shared/error-text";

/** How often a pane opened by id is read again. No snapshot carries it, and
 *  its program changes while the page stays open (a shell starts Codex):
 *  where a scroll goes depends on that program. */
const STANDALONE_PANE_REFRESH_MS = 3_000;

interface LookupState {
  /** The pane these answers are for. The page moves between panes in place
   *  and the hook lives on: what it read for the previous pane says nothing
   *  of the next. */
  paneId: string;
  pane: SnapshotPane | null;
  windowData: SnapshotWindow | null;
  projectId: string | null;
  // "missing": the server says there is no such pane. "error": the first read
  // got no answer about it (Mandate unreachable, a failing server), which is
  // not the same as a pane that was closed.
  status: "idle" | "loading" | "found" | "missing" | "error";
  error: string | null;
}

const NOTHING_READ = { pane: null, windowData: null, projectId: null, error: null };

export function useStandalonePaneLookup({
  enabled,
  paneId,
  refreshMs = STANDALONE_PANE_REFRESH_MS
}: {
  enabled: boolean;
  paneId: string;
  refreshMs?: number;
}) {
  const [state, setState] = useState<LookupState>({ paneId: "", ...NOTHING_READ, status: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !paneId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Has a read found the pane yet? Until one has, each answer stands; a
    // read that got no answer does not undo a 404 (it is not news).
    let known = false;
    let saidMissing = false;
    // Read again for the same pane (Retry): it loads. Another pane already
    // reads as loading until its own answer.
    queueMicrotask(() => {
      if (!cancelled) setState((s) => (s.paneId === paneId ? { ...s, status: "loading" } : s));
    });
    const read = async () => {
      let dto: PaneLookupDto | null = null;
      let failure: string | null = null;
      try {
        const response = await fetch(api.paneById(paneId));
        if (response.ok) {
          const body = await response.json() as PaneByIdResponse;
          dto = "error" in body ? null : body;
        } else if (response.status !== 404) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          failure = body?.error || `request failed (${response.status})`;
        }
      } catch (caught) {
        failure = errorText(caught);
      }
      if (cancelled) return;
      if (!dto) {
        // Once the pane has been found, a later read only refreshes what the
        // page knows and changes nothing when it fails: the terminal's own
        // connection reports a pane that went away. Until then each answer
        // stands, so a first read that got no answer can still turn into a
        // missing pane (a 404) or a found one.
        if (!known && !(failure && saidMissing)) {
          setState({ paneId, ...NOTHING_READ, error: failure, status: failure ? "error" : "missing" });
          saidMissing = !failure;
        }
      } else {
        const nextPane: SnapshotPane = {
          paneId: dto.paneId,
          sessionName: dto.sessionName,
          windowId: dto.windowId,
          windowName: dto.windowName,
          windowIndex: dto.windowIndex,
          paneIndex: dto.paneIndex,
          paneActive: dto.active,
          currentCommand: dto.currentCommand,
          currentPath: dto.currentPath,
          paneWidth: dto.paneWidth,
          paneHeight: dto.paneHeight,
          foregroundProcesses: dto.foregroundProcesses ?? [],
          metadata: dto.metadata
        };
        const nextWindow: SnapshotWindow = {
          sessionName: dto.sessionName,
          windowId: dto.windowId,
          windowIndex: dto.windowIndex,
          windowName: dto.windowName,
          windowActive: false,
          windowPanes: 1,
          windowLayout: "",
          windowZoomed: false,
          panes: [nextPane]
        };
        setState({ paneId, pane: nextPane, windowData: nextWindow, projectId: dto.projectId, error: null, status: "found" });
        known = true;
      }
      timer = setTimeout(() => { void read(); }, refreshMs);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, paneId, refreshMs, attempt]);

  const current = state.paneId === paneId
    ? state
    : { ...NOTHING_READ, status: enabled && paneId ? "loading" as const : "idle" as const };
  const { pane, windowData, status, error, projectId } = current;
  return { pane, windowData, status, error, projectId, retry: () => setAttempt((n) => n + 1) };
}
