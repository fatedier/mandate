import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { PaneHeaderActions } from "@/shell/pane-header-slots";
import { useUiPageSummary } from "@/lib/ui-context";
import type { SessionDto, TmuxSessionsResponse } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-4 pt-1 pb-6 md:px-8">
      {/* Refresh lives in the header band (mobile TopBar / desktop PaneHeader),
          not as an orphan button above the list. */}
      <PaneHeaderActions>
        <RefreshButton onRefresh={refresh} size="icon-xs" />
      </PaneHeaderActions>

      {sessions === null ? (
        <ListRowSkeleton rows={3} />
      ) : session === null ? (
        <div className="rounded-lg border border-border-soft bg-panel p-6">
          <p className="text-sm">Session <span className="font-mono">{sessionName}</span> not found.</p>
          <Link to="/sessions" className="mt-2 inline-flex items-center gap-1 text-sm text-foreground hover:underline">
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Back to all sessions
          </Link>
        </div>
      ) : (
        // One header line, one quiet list: the same list language as Home.
        // The active window earns the only colour on the page — a live dot.
        <section className="flex flex-col gap-1.5">
          <div data-slot="windows-header" className="flex h-8 items-center gap-2">
            <span className="text-xs font-semibold text-foreground">
              {session.ownership === "managed" ? `Managed by ${session.projectName}` : "Unmanaged"}
            </span>
            <span className="num text-2xs text-faint">{plural(session.windows.length, "window")}</span>
          </div>
          {session.windows.length === 0 ? (
            <p className="text-2xs text-faint">No windows in this session.</p>
          ) : (
            <ul className="overflow-hidden rounded-lg border border-border-soft bg-panel">
              {session.windows.map((w) => (
                <li
                  key={`${w.windowId || w.name}-${w.index}`}
                  data-slot="window-row"
                  data-active={w.active ? "true" : "false"}
                  className="border-t border-border-soft first:border-t-0"
                >
                  <Link
                    to={`/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(w.name)}`}
                    className="flex min-h-13 items-center gap-2.5 py-1.5 pr-2 pl-3.5 transition-colors hover:bg-sel"
                  >
                    <span className="num min-w-[22px] shrink-0 font-mono text-2xs text-faint">[{w.index}]</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          data-slot="window-name"
                          className="min-w-0 truncate font-mono text-xs font-medium text-foreground"
                        >
                          {w.name}
                        </span>
                        {w.active && (
                          <span
                            data-slot="window-live"
                            className="size-1.5 shrink-0 rounded-full bg-live"
                            aria-label="Active window"
                          />
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                        {plural(w.panes.length, "pane")}
                        {w.panes.some((p) => p.currentCommand) &&
                          ` · ${w.panes.map((p) => p.currentCommand).filter(Boolean).slice(0, 4).join(", ")}`}
                      </span>
                    </span>
                    <span className="flex size-9 shrink-0 items-center justify-center text-faint" aria-hidden>
                      <ChevronRight className="size-4" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
