import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ExternalLink, MessagesSquare, MoreHorizontal, RefreshCw, Star, Trash2, X } from "lucide-react";
import { threadHref } from "@/lib/feature-href";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import type { WindowInspectRequest, WindowInspectResponse } from "@shared/api-contracts";
import { ArchiveFeatureDialog } from "./ArchiveFeatureDialog";
import { scopeKey, useAgentChatStore, type ChatThreadScope } from "@/store/agent-chat";
import { CompactNowItem } from "./chat/CompactNowItem";
import { BackgroundTasksMenuItem, BackgroundTasksPanel } from "./chat/BackgroundTasksList";
import { ContextBudgetPill } from "./chat/ContextBudgetPill";
import { useFeatureArchive } from "./useFeatureArchive";

interface FeatureActionsMenuProps {
  featureId: string;
  featureName: string;
  featureMode?: string;
  branch?: string | null;
  hasWorktree?: boolean;
  /** Snapshot window; its id drives "Refresh panes". Absent when the tmux
   *  window is missing, in which case the item is disabled. */
  window?: SnapshotWindow;
  /** Pin state and toggle. When `onTogglePin` is absent the item is not shown
   *  (the "Window not found" header has no feature to pin). */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Adds "Close": the thread panel's, which closes the worker's tab. The
   *  worker's page has none: there it went to Projects, read as closing the
   *  menu or the worker, and did neither. */
  onClose?: () => void;
  /** The thread that owns this worker: adds "Open thread". */
  ownerThreadId?: string | null;
  /** The worker's own page: adds "Open worker page" (from the thread's panel). */
  pageHref?: string;
  /** After an archive; the page's default leaves for Projects. */
  onArchived?: () => void;
}

/** The feature page's one ⋯ menu: the worker's background tasks once it has
 *  started one, Refresh panes, a tab's Close, and — last and
 *  separated — Archive worker (confirm dialog, DELETE /api/features/:id, then
 *  back to /projects). One menu instead of three peers: refresh, close and an
 *  irreversible archive used to read as equals on the header rail.
 *
 *  Why a UI control (not just an agent tool): the user expects normal CRUD —
 *  if they made a feature in the UI, they should be able to delete it
 *  from the UI without context-switching to the agent. */
export function FeatureActionsMenu({
  featureId,
  featureName,
  featureMode,
  branch,
  hasWorktree,
  window,
  pinned,
  onTogglePin,
  onClose,
  ownerThreadId = null,
  pageHref,
  onArchived
}: FeatureActionsMenuProps) {
  const navigate = useNavigate();
  const flow = useFeatureArchive({ featureId, featureName, featureMode, branch, hasWorktree, onArchived });
  const { busy } = flow;
  const workerScope = useMemo(() => ({ type: "worker" as const, featureId }), [featureId]);
  // The worker's own thread, once its conversation is read here (its page and
  // the thread's panel read it whichever tab is open): its background tasks.
  const workerThreadId = useAgentChatStore((s) => s.threadsByScope.get(scopeKey(workerScope))?.threadId ?? null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);

  // Refresh is a fallback for when the SSE snapshot looks stale, not the thing
  // you came here to do — which is why it lives in the menu, not on the rail.
  const request = useApi();
  const [refreshing, setRefreshing] = useState(false);
  const refreshPanes = async () => {
    if (!window?.windowId || refreshing) return;
    setRefreshing(true);
    try {
      const body = { windowId: window.windowId } satisfies WindowInspectRequest;
      await request<WindowInspectResponse>("POST", api.windowInspect, body);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      {/* Archive sits last and behind a separator. It is rare and irreversible;
          as a permanent icon beside Refresh it was one click away at all times
          and read as a peer of a reload. This matches how projects already
          expose their destructive action on Home. */}
      {/* Its menu opening closes the background tasks' list: one at a time. */}
      <DropdownMenu onOpenChange={(menuOpen) => { if (menuOpen) setTasksOpen(false); }}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={setMenuButton}
            variant="ghost"
            size="icon-xs"
            aria-label="Worker actions"
            title="Worker actions"
            disabled={busy}
            className="text-chrome"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {workerThreadId && <BackgroundTasksMenuItem threadId={workerThreadId} onOpen={() => setTasksOpen(true)} />}
          <DropdownMenuItem disabled={refreshing || !window?.windowId} onSelect={() => void refreshPanes()}>
            <RefreshCw className="h-4 w-4" />
            Refresh panes
          </DropdownMenuItem>
          <WorkerContextLine scope={workerScope} />
          <CompactNowItem scope={workerScope} />
          {onTogglePin && (
            <DropdownMenuItem onSelect={onTogglePin}>
              <Star className={pinned ? "h-4 w-4 fill-foreground text-foreground" : "h-4 w-4"} />
              {pinned ? "Unpin" : "Pin to top"}
            </DropdownMenuItem>
          )}
          {ownerThreadId && (
            <DropdownMenuItem onSelect={() => navigate(threadHref(ownerThreadId))}>
              <MessagesSquare className="h-4 w-4" />
              Open thread
            </DropdownMenuItem>
          )}
          {pageHref && (
            <DropdownMenuItem onSelect={() => navigate(pageHref)}>
              <ExternalLink className="h-4 w-4" />
              Open worker page
            </DropdownMenuItem>
          )}
          {onClose && (
            <DropdownMenuItem onSelect={onClose}>
              <X className="h-4 w-4" />
              Close
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => void flow.open()}>
            <Trash2 className="h-4 w-4" />
            Archive worker
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {workerThreadId && (
        <BackgroundTasksPanel threadId={workerThreadId} open={tasksOpen} onOpenChange={setTasksOpen} anchor={menuButton} side="bottom" align="end" />
      )}

      <ArchiveFeatureDialog featureName={featureName} branch={branch} flow={flow} />
    </>
  );
}

/** How full the worker's context is, said in its menu and nowhere else: a
 *  worker compacts by itself at its limit, so the figure need not be in sight
 *  all the time, and here it stands above the action that answers it. Nothing
 *  until a call has measured it, or while the worker's conversation is not
 *  read on this page (the worker's view reads it whichever tab is open). */
function WorkerContextLine({ scope }: { scope: ChatThreadScope }) {
  const usage = useAgentChatStore((s) => s.threadsByScope.get(scopeKey(scope))?.contextUsage ?? null);
  return <ContextBudgetPill usage={usage} inMenu />;
}
