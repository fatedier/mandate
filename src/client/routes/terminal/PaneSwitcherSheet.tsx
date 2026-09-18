import { useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { PaneRowList, paneChangedAtFromSnapshot } from "@/routes/sessions/PaneRowList";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { useUIStore } from "@/store/ui";
import { useSnapshotStore } from "@/store/snapshot";
import type { SessionDto, TmuxSessionsResponse } from "@shared/api-contracts";
import { buildSwitcherModel } from "./pane-switcher-model";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionName: string;
  currentPaneId: string;
  hrefFor: (sessionName: string, windowName: string, paneId: string) => string;
}

/** Phone-only bottom sheet: Recent panes (this device, across sessions), then
 *  every window of the session with its panes in tmux order. Fetches the session list on each
 *  open so a pane created a minute ago is there. */
export function PaneSwitcherSheet({ open, onOpenChange, sessionName, currentPaneId, hrefFor }: Props) {
  const request = useApi();
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const session = useMemo(() => sessions.find((s) => s.name === sessionName) ?? null, [sessions, sessionName]);
  const recent = useUIStore((s) => s.recentPanes);
  const forgetPane = useUIStore((s) => s.forgetPane);
  const clearRecentPanes = useUIStore((s) => s.clearRecentPanes);
  // Select the snapshot itself (a stable reference between updates) and derive
  // inside useMemo: a selector that returns a fresh object re-renders on every
  // store update.
  const snapshot = useSnapshotStore((s) => s.snapshot);
  // Activity for the current session plus every session Recent points at.
  const changedAtById = useMemo(() => {
    const names = new Set<string>([sessionName, ...recent.map((r) => r.sessionName)]);
    return Object.assign({}, ...[...names].map((n) => paneChangedAtFromSnapshot(snapshot, n))) as Record<string, string | undefined>;
  }, [snapshot, sessionName, recent]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const r = await request<TmuxSessionsResponse>("GET", api.tmuxSessions);
      if (cancelled || !r) return;
      setSessions(r.sessions);
    })();
    return () => { cancelled = true; };
  }, [open, request, sessionName]);

  const model = useMemo(
    () => buildSwitcherModel({ sessions, sessionName, recent, currentPaneId, changedAtById }),
    [sessions, sessionName, recent, currentPaneId, changedAtById]
  );

  // The sheet opens at the top on purpose: Recent is the reason it exists,
  // so it must be visible the moment the sheet appears. The current pane is
  // highlighted where it sits in the tmux list (and named in the header),
  // not scrolled into view — centring it pushed Recent off-screen whenever
  // the current pane was deep in the list.

  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* outline-none: Radix focuses the content on open and the browser draws
          its default ring around the whole sheet. Focus stays inside for a11y. */}
      <SheetContent side="bottom" showCloseButton={false} className="flex max-h-[80dvh] flex-col gap-0 rounded-t-2xl p-0 outline-none" aria-describedby={undefined}>
        <VisuallyHidden.Root><DialogPrimitive.Title>Switch pane</DialogPrimitive.Title></VisuallyHidden.Root>
        <div data-slot="pane-switcher" className="flex min-h-0 flex-col">
          <div className="flex h-5 shrink-0 items-center justify-center"><span className="h-1 w-9 rounded-full bg-border" /></div>
          {/* One line at 390px: title and legend never wrap; only the session
              meta gives way (truncates) when a long session name presses. */}
          <div className="flex h-8 shrink-0 items-center gap-2 px-4">
            <span data-slot="switcher-title" className="shrink-0 whitespace-nowrap text-xs font-semibold">Switch pane</span>
            <span data-slot="switcher-session" className="min-w-0 truncate font-mono text-2xs text-faint">
              {sessionName}{session ? ` · ${session.windows.length} window${session.windows.length === 1 ? "" : "s"}` : ""}
            </span>
            <span className="flex-1" />
            <span data-slot="switcher-legend" className="flex shrink-0 items-center gap-1 whitespace-nowrap text-2xs text-faint"><span className="size-1.5 rounded-full bg-live" aria-hidden />recent output</span>
          </div>
          <div className="min-h-0 overflow-y-auto px-2 pb-3">
            {model.recent.length > 0 && (
              <section data-slot="switcher-group" data-group="recent" className="flex flex-col gap-0.5">
                <div className="flex h-7 items-center gap-2 px-2">
                  <span className="label-micro text-chrome">Recent</span>
                  <span className="text-2xs text-faint">last opened first</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    data-slot="switcher-clear"
                    onClick={clearRecentPanes}
                    className="relative h-7 px-2 text-2xs text-faint transition-colors hover:text-foreground before:absolute before:-inset-y-2 before:inset-x-0 before:content-['']"
                  >
                    Clear
                  </button>
                </div>
                <PaneRowList
                  dense
                  panes={model.recent}
                  hrefFor={(p) => { const r = model.recent.find((x) => x.paneId === p.paneId)!; return hrefFor(r.sessionName, r.windowName, p.paneId); }}
                  currentPaneId={currentPaneId}
                  onNavigate={close}
                  onDismiss={(p) => forgetPane(p.paneId)}
                />
                <div className="mx-2 my-1.5 h-px bg-border-soft" />
              </section>
            )}
            <div className="flex h-7 items-center gap-2 px-2"><span className="label-micro text-chrome">All windows</span><span className="text-2xs text-faint">tmux order</span></div>
            {model.windows.map((w) => (
              <section key={w.windowName} data-slot="switcher-group" data-group={w.windowName} className="flex flex-col gap-0.5">
                <div className="mt-1 flex h-7 items-center gap-2 px-2">
                  <span className="font-mono text-2xs text-faint">[{w.index}]</span>
                  <span className={cn("font-mono text-2xs", w.active ? "font-semibold text-foreground" : "text-muted-foreground")}>{w.windowName}</span>
                  <span className="text-2xs text-faint">· {w.panes.length} pane{w.panes.length === 1 ? "" : "s"}</span>
                </div>
                <PaneRowList dense panes={w.panes} hrefFor={(p) => hrefFor(sessionName, w.windowName, p.paneId)} currentPaneId={currentPaneId} onNavigate={close} />
              </section>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
