import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Boxes, ChevronRight } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { Button } from "@/components/ui/button";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/shell/PageHeader";
import { useProjectsStore } from "@/store/projects";
import { useUiPageSummary } from "@/lib/ui-context";
import { AdoptDialog } from "./AdoptDialog";
import type { SessionDto, TmuxSessionsResponse } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<string | null>(null);
  const request = useApi();
  const projectsById = useProjectsStore((s) => s.byId);

  const refresh = useCallback(async () => {
    const r = await request<TmuxSessionsResponse>("GET", api.tmuxSessions);
    if (r && Array.isArray(r.sessions)) setSessions(r.sessions);
  }, [request]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Refresh when the project store changes (a fresh adopt should remove the
  // session from the unmanaged list).
  useEffect(() => { void refresh(); }, [projectsById, refresh]);
  useUiPageSummary("sessions", () => ({
    page: "sessions",
    loaded: sessions !== null,
    sessionCount: sessions?.length ?? 0,
    sessions: (sessions ?? []).slice(0, 50).map((session) => ({
      name: session.name,
      ownership: session.ownership,
      projectId: session.projectId,
      projectName: session.projectName,
      windowCount: session.windows.length,
      paneCount: session.windows.reduce((sum, w) => sum + w.panes.length, 0)
    }))
  }));

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1280px] w-full mx-auto">
      <PageHeader
        subtitle="All tmux sessions on this machine. Click a session to drill into its windows and panes."
        trailing={<RefreshButton onRefresh={refresh} />}
      />

      {sessions === null ? (
        <ListRowSkeleton rows={3} />
      ) : sessions.length === 0 ? (
        <div className="py-16 text-center">
          <Boxes className="mx-auto h-8 w-8 text-chrome/50" aria-hidden />
          <h3 className="mt-3 text-lg font-semibold">No tmux sessions detected</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Create a session in your terminal, then refresh this page.
          </p>
        </div>
      ) : (
        // A list is a run of rows, not a stack of cards. Six bordered boxes in a
        // column drew six frames to say one thing: these are siblings.
        <ul className="flex flex-col divide-y divide-border-soft overflow-hidden rounded-lg border border-border-soft">
          {sessions.map((s) => (
            <li key={s.name}>
              <Link
                to={`/sessions/${encodeURIComponent(s.name)}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.04]"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold truncate">{s.name}</span>
                    {s.ownership === "managed" ? (
                      <span className="text-xs text-muted-foreground">
                        managed by <span className="text-primary">{s.projectName}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-amber">unmanaged</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {s.windows.length} window{s.windows.length === 1 ? "" : "s"}
                    {s.windows.length > 0 && (
                      <>
                        {" · "}
                        {s.windows.reduce((sum, w) => sum + w.panes.length, 0)} pane
                        {s.windows.reduce((sum, w) => sum + w.panes.length, 0) === 1 ? "" : "s"}
                      </>
                    )}
                  </p>
                </div>
                {s.ownership === "unmanaged" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setAdoptTarget(s.name);
                    }}
                  >
                    Adopt
                  </Button>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-chrome" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {adoptTarget !== null && (
        <AdoptDialog
          open={true}
          onOpenChange={(next) => { if (!next) setAdoptTarget(null); }}
          sessionName={adoptTarget}
        />
      )}
    </div>
  );
}
