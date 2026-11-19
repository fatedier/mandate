import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { api } from "@/lib/api-paths";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { PaneHeaderActions } from "@/shell/pane-header-slots";
import { TmuxLayoutBoard } from "@/routes/window/TmuxLayoutBoard";
import { PaneRowList, paneChangedAtFromSnapshot, paneRowsFromWindow } from "@/routes/terminals/PaneRowList";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSnapshotStore } from "@/store/snapshot";
import { cn } from "@/lib/utils";
import type { SnapshotPane, SnapshotWindow } from "@/lib/snapshot-types";
import type { SessionWindowResponse, WindowDetailDto } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";
import { BackLink, StateAction, StateMessage } from "@/components/ViewState";
import { errorText } from "@shared/error-text";
import { terminalHref } from "@/lib/terminals-model";

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
  const params = useParams<{ windowId: string }>();
  const windowId = params.windowId ?? "";
  const [detail, setDetail] = useState<WindowDetailDto | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const isPhone = useIsMobile();
  const snapshot = useSnapshotStore((s) => s.snapshot);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const r = await fetch(api.terminalWindow(windowId));
      if (r.status === 404) { setDetail(null); setStatus("missing"); return; }
      const body = await r.json().catch(() => null) as SessionWindowResponse | null;
      if (!r.ok || !body || "error" in body) {
        setFailure(body && "error" in body && body.error ? body.error : `request failed (${r.status})`);
        setStatus("error");
        return;
      }
      setDetail(body.window);
      setStatus("found");
    } catch (error) {
      setFailure(errorText(error));
      setStatus("error");
    }
  }, [windowId]);

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
    () => (detail ? paneRowsFromWindow(detail, paneChangedAtFromSnapshot(snapshot, detail.sessionName)) : []),
    [detail, snapshot]
  );
  const pidOf = (paneId: string) => detail?.panes.find((p) => p.paneId === paneId)?.pid ?? 0;
  const hrefFor = (p: { paneId: string }) => terminalHref(p.paneId, pidOf(p.paneId));


  return (
    <div className={cn("mx-auto flex w-full flex-col gap-4 px-4 pt-1 pb-6 md:px-8", showRows ? "max-w-[1040px]" : "max-w-[1280px]")}>
      <PaneHeaderActions>
        <RefreshButton onRefresh={refresh} size="icon-xs" />
      </PaneHeaderActions>

      {detail && (
        <div data-slot="window-header" className="flex h-8 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{detail.sessionName} › {detail.name}</span>
          <span className="shrink-0 text-xs font-semibold text-foreground">Window {detail.index}</span>
          <span className="num text-2xs text-faint">{detail.panes.length} pane{detail.panes.length === 1 ? "" : "s"}</span>
          <span className="flex-1" />
          {isPhone && <span className="text-2xs text-faint">tap a pane to open its terminal</span>}
        </div>
      )}

      {status === "loading" ? (
        <ListRowSkeleton rows={3} />
      ) : status === "missing" ? (
        <StateMessage title="Window not found" action={<BackLink to="/terminals">Back to Terminals</BackLink>}>
          This window has closed.
        </StateMessage>
      ) : status === "error" || detail === null || snapshotWindow === null ? (
        <StateMessage title="Couldn't load this window" detail={status === "error" ? failure : null} action={<StateAction onClick={() => void refresh()}>Retry</StateAction>} />
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
