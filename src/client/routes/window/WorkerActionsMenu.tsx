import { useMemo, useState } from "react";
import { MoreHorizontal, RefreshCw, Star, Trash2, X } from "lucide-react";
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
import { ArchiveWorkerDialog } from "./ArchiveWorkerDialog";
import { scopeKey, useAgentChatStore, type ChatThreadScope } from "@/store/agent-chat";
import { CompactNowItem } from "./chat/CompactNowItem";
import { BackgroundTasksMenuItem, BackgroundTasksPanel } from "./chat/BackgroundTasksList";
import { ContextBudgetPill } from "./chat/ContextBudgetPill";
import { useWorkerArchive } from "./useWorkerArchive";

interface WorkerActionsMenuProps {
  workerId: string;
  workerName: string;
  workerMode?: string;
  branch?: string | null;
  hasWorktree?: boolean;
  /** Snapshot window; its id drives "Refresh panes". Absent when the tmux
   *  window is missing, in which case the item is disabled. */
  window?: SnapshotWindow;
  pinned: boolean;
  onTogglePin: () => void;
  /** "Close": closes the worker's tab in the thread's panel. */
  onClose: () => void;
  /** After an archive. */
  onArchived: () => void;
}

/** A worker's one ⋯ menu, at the end of its tab row in the thread's panel:
 *  its background tasks once it has started one, Refresh panes, Pin, Close,
 *  and — last and separated — Archive worker (confirm dialog,
 *  DELETE /api/workers/:id). One menu instead of three peers: on the header
 *  rail, refresh, close and an irreversible archive would read as equals.
 *
 *  Why a UI control (not just an agent tool): the user expects normal CRUD —
 *  if they made a worker in the UI, they should be able to delete it
 *  from the UI without context-switching to the agent. */
export function WorkerActionsMenu({
  workerId,
  workerName,
  workerMode,
  branch,
  hasWorktree,
  window,
  pinned,
  onTogglePin,
  onClose,
  onArchived
}: WorkerActionsMenuProps) {
  const flow = useWorkerArchive({ workerId, workerName, workerMode, branch, hasWorktree, onArchived });
  const { busy } = flow;
  const workerScope = useMemo(() => ({ type: "worker" as const, workerId }), [workerId]);
  // The worker's own thread, once its conversation is read here (the
  // thread's panel reads it whichever tab is open): its background tasks.
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
          <DropdownMenuItem onSelect={onTogglePin}>
            <Star className={pinned ? "h-4 w-4 fill-foreground text-foreground" : "h-4 w-4"} />
            {pinned ? "Unpin" : "Pin to top"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onClose}>
            <X className="h-4 w-4" />
            Close
          </DropdownMenuItem>
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

      <ArchiveWorkerDialog workerName={workerName} branch={branch} flow={flow} />
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
