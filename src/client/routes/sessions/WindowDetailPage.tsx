import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api-paths";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { PaneHeaderActions } from "@/shell/pane-header-slots";
import { TmuxLayoutBoard } from "@/routes/window/TmuxLayoutBoard";
import { PaneRowList, paneChangedAtFromSnapshot, paneRowsFromWindow } from "@/routes/sessions/PaneRowList";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSnapshotStore } from "@/store/snapshot";
import { useUiPageSummary } from "@/lib/ui-context";
import { cn } from "@/lib/utils";
import type { SnapshotPane, SnapshotWindow } from "@/lib/snapshot-types";
import type { SessionWindowResponse, WindowDetailDto } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";

type LoadStatus = "loading" | "found" | "missing" | "error";

function toSnapshotWindow(detail: WindowDetailDto): SnapshotWindow {
  const panes: SnapshotPane[] = detail.panes.map((p) => ({
    sessionName: detail.sessionName,
    windowId: detail.windowId,
    windowName: detail.name,
    paneId: p.paneId,
    paneIndex: p.index,
    paneActive: p.active,
    currentCommand: p.currentCommand,
    currentPath: p.currentPath,
    preview: p.preview,
    metadata: p.metadata
  }));
  return {
    sessionName: detail.sessionName,
    windowId: detail.windowId,
    windowName: detail.name,
    windowIndex: detail.index,
    windowActive: detail.active,
    windowLayout: detail.windowLayout,
    windowPanes: panes.length,
    panes,
  };
}

export function WindowDetailPage() {
  const params = useParams<{ sessionName: string; windowName: string }>();
  const sessionName = params.sessionName ?? "";
  const windowName = params.windowName ?? "";
  const [detail, setDetail] = useState<WindowDetailDto | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const isPhone = useIsMobile();
  const snapshot = useSnapshotStore((s) => s.snapshot);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const r = await fetch(api.windowDetail(sessionName, windowName));
      if (r.status === 404) { setDetail(null); setStatus("missing"); return; }
      if (!r.ok) { setStatus("error"); return; }
      const body = await r.json() as SessionWindowResponse;
      if ("error" in body) { setStatus("error"); return; }
      setDetail(body.window);
      setStatus("found");
    } catch {
      setStatus("error");
    }
  }, [sessionName, windowName]);

  useEffect(() => { void refresh(); }, [refresh]);

  const snapshotWindow = useMemo(
    () => (detail ? toSnapshotWindow(detail) : null),
    [detail]
  );
  const hasLayout = !!snapshotWindow?.windowLayout && (snapshotWindow.panes?.length ?? 0) > 0;
  // Pane rows stand in for the layout board on phones (the board needs
  // width) and at every width when tmux reported no layout.
  const showRows = isPhone || !hasLayout;
  const paneRows = useMemo(
    () => (detail ? paneRowsFromWindow(detail, paneChangedAtFromSnapshot(snapshot, sessionName)) : []),
    [detail, snapshot, sessionName]
  );
  const hrefFor = (p: { paneId: string }) =>
    `/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(windowName)}/pane/${encodeURIComponent(p.paneId)}`;

  useUiPageSummary("session-window-detail", () => ({
    page: "session-window-detail",
    sessionName,
    windowName,
    status,
    window: detail
      ? {
          windowId: detail.windowId,
          index: detail.index,
          active: detail.active,
          paneCount: detail.panes.length,
          panes: detail.panes.slice(0, 50).map((pane) => ({
            paneId: pane.paneId,
            index: pane.index,
            active: pane.active,
            currentCommand: pane.currentCommand,
            currentPath: pane.currentPath
          }))
        }
      : null
  }));

  return (
    <div className={cn("mx-auto flex w-full flex-col gap-4 px-4 pt-1 pb-6 md:px-8", showRows ? "max-w-[1040px]" : "max-w-[1280px]")}>
      <PaneHeaderActions>
        <RefreshButton onRefresh={refresh} size="icon-xs" />
      </PaneHeaderActions>

      {detail && (
        <div data-slot="window-header" className="flex h-8 items-center gap-2">
          <span className="text-xs font-semibold text-foreground">Window {detail.index}</span>
          <span className="num text-2xs text-faint">{detail.panes.length} pane{detail.panes.length === 1 ? "" : "s"}</span>
          <span className="flex-1" />
          {isPhone && <span className="text-2xs text-faint">tap a pane to open its terminal</span>}
        </div>
      )}

      {status === "loading" ? (
        <ListRowSkeleton rows={3} />
      ) : status === "missing" ? (
        <div className="rounded-lg border border-border-soft bg-panel p-6">
          <p className="text-sm">
            Window <span className="font-mono">{windowName}</span> not found in session{" "}
            <span className="font-mono">{sessionName}</span>.
          </p>
          <Link
            to={`/sessions/${encodeURIComponent(sessionName)}`}
            className="mt-2 inline-flex items-center gap-1 text-sm text-foreground hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Back to session
          </Link>
        </div>
      ) : status === "error" || detail === null || snapshotWindow === null ? (
        <div className="rounded-lg border border-border-soft bg-panel p-6">
          <p className="text-sm">Failed to load window.</p>
        </div>
      ) : detail.panes.length === 0 ? (
        <div className="rounded-lg border border-border-soft bg-panel p-6 text-center">
          <p className="text-sm text-muted-foreground">No panes in this window.</p>
        </div>
      ) : showRows ? (
        <PaneRowList panes={paneRows} hrefFor={hrefFor} />
      ) : (
        <TmuxLayoutBoard
          window={snapshotWindow}
          paneHref={(pane) => (pane.paneId ? hrefFor({ paneId: pane.paneId }) : null)}
          onAfterChange={refresh}
        />
      )}
    </div>
  );
}
