import { useEffect, useState } from "react";
import { api } from "@/lib/api-paths";
import type { SnapshotPane, SnapshotWindow } from "@/lib/snapshot-types";
import type { PaneByIdResponse, PaneLookupDto } from "@shared/api-contracts";

export function useStandalonePaneLookup({
  enabled,
  paneId
}: {
  enabled: boolean;
  paneId: string;
}) {
  const [pane, setPane] = useState<SnapshotPane | null>(null);
  const [windowData, setWindowData] = useState<SnapshotWindow | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "found" | "missing">("idle");
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !paneId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setStatus("loading");
    });
    void (async () => {
      let dto: PaneLookupDto | null = null;
      try {
        const response = await fetch(api.paneById(paneId));
        if (response.ok) {
          const body = await response.json() as PaneByIdResponse;
          dto = "error" in body ? null : body;
        }
      } catch {
        /* network error -> treat as missing */
      }
      if (cancelled) return;
      if (!dto) {
        setPane(null);
        setWindowData(null);
        setProjectId(null);
        setStatus("missing");
        return;
      }
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
      setPane(nextPane);
      setWindowData(nextWindow);
      setProjectId(dto.projectId);
      setStatus("found");
    })();
    return () => { cancelled = true; };
  }, [enabled, paneId]);

  return { pane, windowData, status, projectId };
}
