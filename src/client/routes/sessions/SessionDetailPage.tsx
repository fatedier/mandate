import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/shell/PageHeader";
import { useUiPageSummary } from "@/lib/ui-context";
import type { SessionDto, TmuxSessionsResponse } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";

export function SessionDetailPage() {
  const params = useParams<{ sessionName: string }>();
  const sessionName = params.sessionName ?? "";
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const request = useApi();

  const refresh = useCallback(async () => {
    const r = await request<TmuxSessionsResponse>("GET", api.tmuxSessions);
    if (r && Array.isArray(r.sessions)) setSessions(r.sessions);
  }, [request]);

  useEffect(() => { void refresh(); }, [refresh]);

  const session = useMemo(
    () => sessions?.find((s) => s.name === sessionName) ?? null,
    [sessions, sessionName]
  );
  useUiPageSummary("session-detail", () => ({
    page: "session-detail",
    sessionName,
    loaded: sessions !== null,
    found: Boolean(session),
    session: session
      ? {
          name: session.name,
          ownership: session.ownership,
          projectId: session.projectId,
          projectName: session.projectName,
          windows: session.windows.slice(0, 50).map((window) => ({
            name: window.name,
            index: window.index,
            active: window.active,
            paneCount: window.panes.length,
            commands: window.panes.map((pane) => pane.currentCommand).filter(Boolean).slice(0, 10)
          }))
        }
      : null
  }));

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1280px] w-full mx-auto">
      <PageHeader
        subtitle={
          session?.ownership === "managed"
            ? `Managed by project ${session.projectName}`
            : session?.ownership === "unmanaged"
              ? "Unmanaged tmux session"
              : ""
        }
        trailing={<RefreshButton onRefresh={refresh} />}
      />

      {sessions === null ? (
        <ListRowSkeleton rows={3} />
      ) : session === null ? (
        <div className="rounded-lg border border-border-soft bg-card p-6">
          <p className="text-sm">Session <span className="font-mono">{sessionName}</span> not found.</p>
          <Link to="/sessions" className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Back to all sessions
          </Link>
        </div>
      ) : session.windows.length === 0 ? (
        <div className="rounded-lg border border-border-soft bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">No windows in this session.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {session.windows.map((w) => (
            <li key={`${w.windowId || w.name}-${w.index}`}>
              <Link
                to={`/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(w.name)}`}
                className="flex items-center gap-3 rounded-lg border border-border-soft bg-card p-4 hover:bg-card/70 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      [{w.index}]
                    </span>
                    <span className="font-mono text-sm font-semibold truncate">{w.name}</span>
                    {w.active && (
                      <span className="text-xs text-primary">active</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {w.panes.length} pane{w.panes.length === 1 ? "" : "s"}
                    {w.panes.length > 0 && w.panes[0]!.currentCommand && (
                      <> · {w.panes.map((p) => p.currentCommand).filter(Boolean).slice(0, 4).join(", ")}</>
                    )}
                  </p>
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
