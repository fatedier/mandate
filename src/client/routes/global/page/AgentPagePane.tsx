import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2, PanelRightClose, PanelTop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { LoadingLine } from "@/components/ViewState";
import { formatClockMinutes } from "@/lib/format";
import { useAgentChatStore } from "@/store/agent-chat";
import { useAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import type { AgentPageVersionDto } from "@shared/api/agent-page";
import { pageFailureShown } from "@shared/page-run-failure";
import { AgentPageFrame } from "./AgentPageFrame";
import { SourcesMenu } from "./SourcesMenu";
import { PanelTabRow } from "@/components/PanelTabRow";
import { useIsMobile } from "@/hooks/useIsMobile";
import { canvasTabId } from "@/lib/panel-tabs";
import { canvasIdOfPath, canvasPathOf } from "@/lib/canvas-link";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { cn } from "@/lib/utils";
import { usePanelCanvasTabs } from "@/routes/canvas/panel-canvas-tabs";
import { PanelCanvasViews } from "@/routes/canvas/PanelCanvasViews";

/** How often the usage source is read again while the page is shown. */
export const PAGE_USAGE_REFRESH_MS = 5 * 60_000;

/**
 * Your agent's page beside its chat: a header that says when it was last
 * published and how its page subagent is doing, its sources, and the page in
 * its frame. A version that lands while the user types in one of its fields
 * waits for them: until they leave the field, or press Reload.
 */
export function AgentPagePane({ name, threadId }: { name: string; threadId: string }) {
  const state = useAgentPageStore((s) => s.state);
  const version = useAgentPageStore((s) => s.version);
  const sources = useAgentPageStore((s) => s.sources);
  const data = useAgentPageStore((s) => s.data);
  const followed = useAgentPageStore((s) => s.followed);
  const held = useAgentPageStore((s) => s.held);
  const heldCleared = useAgentPageStore((s) => s.heldCleared);
  const maximized = useAgentPageUi((s) => s.maximized);
  const narrow = useAgentPageUi((s) => s.narrow);
  const navigate = useNavigate();

  // Read now, and again whenever the event stream comes back (a change
  // published while it was down is not sent again). Usage, now and then.
  useEffect(() => {
    const refresh = () => { void useAgentPageStore.getState().refresh().catch(() => {}); };
    refresh();
    window.addEventListener("mandate:sse-open", refresh);
    const usage = window.setInterval(() => {
      const store = useAgentPageStore.getState();
      if (store.followed.has("usage")) void store.fetchData("usage").catch(() => {});
    }, PAGE_USAGE_REFRESH_MS);
    return () => {
      window.removeEventListener("mandate:sse-open", refresh);
      window.clearInterval(usage);
    };
  }, []);

  // The version kept while a field of it has focus; null: the latest shows.
  const [pinned, setPinned] = useState<AgentPageVersionDto | null>(null);
  const shown = pinned ?? version;
  const newer = pinned !== null && version !== null && version.revision > pinned.revision;
  const onFocus = useCallback((inField: boolean) => {
    // Typing holds the version on screen, from one field to the next;
    // leaving the fields lets the latest in.
    setPinned((current) => (inField ? current ?? useAgentPageStore.getState().version : null));
  }, []);
  const onFields = useCallback((values: Record<string, string>) => { useAgentPageStore.getState().setHeld(values); }, []);
  // Only data kept current: a source nobody follows may be old, so a get
  // waits for the read that following it starts.
  const readData = useCallback((source: string) => (followed.has(source) ? data.get(source) ?? null : null), [data, followed]);
  const subscribe = useCallback((source: string) => { useAgentPageStore.getState().follow(source); }, []);
  const unsubscribe = useCallback((source: string) => { useAgentPageStore.getState().unfollow(source); }, []);
  // A kept answer lets go of what was typed, here too: the frame that sent
  // it may be gone by then (the user went to the chat).
  const submit = useCallback(async (value: unknown) => {
    const result = await useAgentPageStore.getState().submit(value);
    if (result.ok) useAgentPageStore.getState().clearHeld();
    return result;
  }, []);
  // A canvas the page links to opens as any canvas does on this page (beside
  // the chat on a desktop); another of Mandate's pages is gone to.
  const openCanvas = useOpenCanvas();
  const open = useCallback((path: string) => {
    const canvas = canvasPathOf(path, window.location.href);
    const canvasId = canvas ? canvasIdOfPath(canvas) : null;
    if (canvas && canvasId) openCanvas(canvasId, canvas);
    else void navigate(path);
  }, [navigate, openCanvas]);

  const write = state?.write ?? null;
  const latest = state?.latest ?? null;
  const updating = write?.status === "running";
  // A failure after the page last changed: the page shown is the last good one.
  const failed = write?.status === "failed" && (!latest || (write.finishedAt ?? "") >= latest.createdAt) ? write : null;
  const failedShown = failed?.error ? pageFailureShown(failed.error, name) : null;
  const ui = useAgentPageUi.getState;
  // Canvases open beside the page as tabs on a desktop; a phone shows the
  // page alone (a canvas opens full screen there).
  const phone = useIsMobile();
  const savedTabs = useAgentPageUi((s) => s.tabs);
  const savedActive = useAgentPageUi((s) => s.active);
  const tabIds = phone ? NO_TABS : savedTabs;
  const active = tabIds.includes(savedActive) ? savedActive : "page";
  const canvasTabs = usePanelCanvasTabs(tabIds, active, (id) => ui().closeTab(id));
  // In a narrow row hiding means going back to the chat.
  const hide = () => {
    if (narrow) return ui().setNarrowView("chat");
    ui().setOpen(false);
    ui().setMaximized(false);
  };
  const zoom = !narrow && <PaneZoomButton kind="page" zoomed={maximized} onClick={() => ui().setMaximized(!maximized)} />;
  const said = (
    <>
      {latest && <span className="num truncate text-xs text-faint">· updated {formatClockMinutes(latest.createdAt)}</span>}
      {updating && (
        <span data-slot="page-updating" className="flex shrink-0 items-center gap-1 text-xs text-live">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          Updating…
        </span>
      )}
      {!updating && failed && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" data-slot="page-failed" title={failedShown ?? undefined} className="hit relative shrink-0 text-xs text-destructive">
              · Update failed
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(300px,calc(100vw-2rem))] text-xs leading-relaxed">
            {failedShown}
          </PopoverContent>
        </Popover>
      )}
      <div className="min-w-0 flex-1" />
      {newer && (
        <Button size="xs" onClick={() => setPinned(null)} className="shrink-0">New version — Reload</Button>
      )}
      {sources.length > 0 && (
        <SourcesMenu
          sources={sources}
          onPause={(source, paused) => useAgentPageStore.getState().setPaused(source, paused)}
          onRemove={(source) => useAgentPageStore.getState().remove(source)}
        />
      )}
    </>
  );
  return (
    <div data-pane-mode="page" className="flex min-h-0 flex-1 flex-col">
      {!phone && (
        <PanelTabRow
          first={{ label: "Page", icon: <PanelTop aria-hidden className="size-3.5 shrink-0" /> }}
          tabs={tabIds.flatMap((id) => canvasTabs.items.get(id) ?? [])}
          active={active === "page" ? "first" : active}
          onSelect={(id) => ui().setActive(id === "first" ? "page" : id)}
          tools={(
            <>
              {zoom}
              <button
                type="button"
                aria-label="Hide panel"
                title="Hide panel"
                onClick={hide}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-chrome hover:bg-sel hover:text-foreground"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          ariaLabel="Page tabs"
        />
      )}
      {/* Kept while a canvas tab shows: its frame and what was typed in it
          stay as they were. */}
      <div data-slot="agent-page-body" className={cn("min-h-0 flex-1 flex-col", active === "page" ? "flex" : "hidden")}>
        {/* Its title, when it was updated and how its writer is doing, its
            sources: under the tab row on a desktop (as a canvas tab's bar),
            with Hide page on a phone, where there is no tab row. */}
        <div data-slot="page-toolbar" className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft pl-3 pr-2 pointer-coarse:gap-3">
          <span className="shrink-0 text-sm font-semibold text-foreground">Page</span>
          {said}
          {phone && zoom}
          {phone && (
            <button
              type="button"
              aria-label="Hide page"
              title="Hide page"
              onClick={hide}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-chrome hover:bg-sel hover:text-foreground"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {state === null ? (
            <div className="px-4 pt-6"><LoadingLine /></div>
          ) : !latest ? (
            <PageEmptyState name={name} threadId={threadId} making={updating} />
          ) : !shown ? (
            <div className="px-4 pt-6"><LoadingLine /></div>
          ) : (
            <AgentPageFrame
              version={shown}
              held={held}
              onFields={onFields}
              onFocus={onFocus}
              data={readData}
              subscribe={subscribe}
              unsubscribe={unsubscribe}
              submit={submit}
              open={open}
              clearCount={heldCleared}
            />
          )}
        </div>
      </div>
      <PanelCanvasViews kept={canvasTabs.kept} active={canvasTabs.activeCanvas} onClose={(canvasId) => ui().closeTab(canvasTabId(canvasId))} />
    </div>
  );
}

const NO_TABS: string[] = [];

/** Before the first page; `making`: a page subagent is making it, so asking
 *  again would only queue another. */
function PageEmptyState({ name, threadId, making }: { name: string; threadId: string; making: boolean }) {
  const [sending, setSending] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3.5 px-5 text-center">
      <p className="text-sm text-muted-foreground">{name} hasn't made a page yet.</p>
      <Button
        variant="outline"
        disabled={sending || making}
        onClick={() => {
          setSending(true);
          void useAgentChatStore.getState().sendMessage({ type: "global", threadId }, "Make your page.").finally(() => setSending(false));
        }}
      >
        Ask {name} to make its page
      </Button>
    </div>
  );
}
