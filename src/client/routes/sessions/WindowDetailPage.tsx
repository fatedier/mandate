import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api-paths";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/shell/PageHeader";
import { TmuxLayoutBoard } from "@/routes/window/TmuxLayoutBoard";
import { useUiPageSummary } from "@/lib/ui-context";
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
    <div className="flex flex-col gap-6 p-6 max-w-[1280px] w-full mx-auto">
      <PageHeader
        subtitle={
          detail
            ? `Window ${detail.index} · ${detail.panes.length} pane${detail.panes.length === 1 ? "" : "s"}`
            : ""
        }
        trailing={<RefreshButton onRefresh={refresh} />}
      />

      {status === "loading" ? (
        <ListRowSkeleton rows={3} />
      ) : status === "missing" ? (
        <div className="rounded-lg border border-border-soft bg-card p-6">
          <p className="text-sm">
            Window <span className="font-mono">{windowName}</span> not found in session{" "}
            <span className="font-mono">{sessionName}</span>.
          </p>
          <Link
            to={`/sessions/${encodeURIComponent(sessionName)}`}
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Back to session
          </Link>
        </div>
      ) : status === "error" || detail === null || snapshotWindow === null ? (
        <div className="rounded-lg border border-border-soft bg-card p-6">
          <p className="text-sm">Failed to load window.</p>
        </div>
      ) : detail.panes.length === 0 ? (
        <div className="rounded-lg border border-border-soft bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">No panes in this window.</p>
        </div>
      ) : hasLayout ? (
        <TmuxLayoutBoard
          window={snapshotWindow}
          paneHref={(pane) =>
            pane.paneId
              ? `/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(windowName)}/pane/${encodeURIComponent(pane.paneId)}`
              : null
          }
          onAfterChange={refresh}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {detail.panes.map((p) => (
            <li key={p.paneId}>
              <Link
                to={`/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(windowName)}/pane/${encodeURIComponent(p.paneId)}`}
                className="flex items-center gap-3 rounded-lg border border-border-soft bg-card p-4 hover:bg-card/70 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">[{p.index}]</span>
                    <span className="font-mono text-sm font-semibold">{p.metadata?.name || p.paneId}</span>
                    {p.active && <span className="text-xs text-primary">active</span>}
                    {p.metadata?.description && (
                      <span className="text-xs text-muted-foreground truncate">{p.metadata.description}</span>
                    )}
                    {p.currentCommand && (
                      <span className="text-xs text-muted-foreground font-mono">{p.currentCommand}</span>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
