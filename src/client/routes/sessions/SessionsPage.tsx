import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Boxes, ChevronRight } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { Button } from "@/components/ui/button";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { PaneHeaderActions } from "@/shell/pane-header-slots";
import { useProjectsStore, type Project } from "@/store/projects";
import { useUiPageSummary } from "@/lib/ui-context";
import { AdoptDialog } from "./AdoptDialog";
import type { SessionDto, TmuxSessionsResponse } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";

const paneCount = (s: SessionDto) => s.windows.reduce((sum, w) => sum + w.panes.length, 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Home's rule (ProjectSection.resolveProjectTmuxStatus): the newer tmuxStatus
// wins, tmuxAlive is the fallback — so the two surfaces never disagree.
const projectAlive = (p: Project | undefined) =>
  p ? (p.tmuxStatus ?? (p.tmuxAlive ? "alive" : "gone")) === "alive" : false;

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
      paneCount: paneCount(session)
    }))
  }));

  const unmanaged = (sessions ?? []).filter((s) => s.ownership === "unmanaged").length;

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-4 pt-1 pb-6 md:px-8">
      {/* Refresh lives in the header band (mobile TopBar / desktop PaneHeader),
          not as an orphan button above the list. */}
      <PaneHeaderActions>
        <RefreshButton onRefresh={refresh} size="icon-xs" />
      </PaneHeaderActions>

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
        // One header line, one quiet list: the same list language as Home.
        // Colour is reserved for status — the unmanaged pill and the live dot.
        <section className="flex flex-col gap-1.5">
          <div data-slot="sessions-header" className="flex h-8 items-center gap-2">
            <span className="text-xs font-semibold text-foreground">tmux sessions</span>
            <span className="num text-2xs text-faint">{sessions.length}</span>
            <span className="flex-1" />
            {unmanaged > 0 && <span className="text-2xs text-faint">{unmanaged} unmanaged</span>}
          </div>
          <ul className="overflow-hidden rounded-lg border border-border-soft bg-panel">
            {sessions.map((s) => {
              const alive = projectAlive(s.projectId ? projectsById[s.projectId] : undefined);
              return (
                <li
                  key={s.name}
                  data-slot="session-row"
                  data-ownership={s.ownership}
                  className="border-t border-border-soft first:border-t-0"
                >
                  <Link
                    to={`/sessions/${encodeURIComponent(s.name)}`}
                    className="flex min-h-13 items-center gap-2.5 py-1.5 pr-2 pl-3.5 transition-colors hover:bg-sel"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          data-slot="session-name"
                          className="min-w-0 truncate font-mono text-xs font-medium text-foreground"
                        >
                          {s.name}
                        </span>
                        {s.ownership === "unmanaged" && <span className="pill pill-amber">unmanaged</span>}
                        {alive && (
                          <span
                            data-slot="session-live"
                            className="size-1.5 shrink-0 rounded-full bg-live"
                            aria-label="Project session alive"
                          />
                        )}
                      </span>
                      <span
                        data-slot="session-meta"
                        className="mt-0.5 block truncate text-2xs text-muted-foreground"
                      >
                        {s.ownership === "managed" && s.projectName ? `${s.projectName} · ` : ""}
                        {plural(s.windows.length, "window")} · {plural(paneCount(s), "pane")}
                      </span>
                    </span>
                    {s.ownership === "unmanaged" && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setAdoptTarget(s.name);
                        }}
                      >
                        Adopt
                      </Button>
                    )}
                    <span className="flex size-9 shrink-0 items-center justify-center text-faint" aria-hidden>
                      <ChevronRight className="size-4" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
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
