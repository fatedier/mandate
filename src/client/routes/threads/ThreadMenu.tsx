import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { MoreHorizontal, PanelRight, Pencil, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { cn } from "@/lib/utils";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { CompactNowItem } from "@/routes/window/chat/CompactNowItem";
import { BackgroundTasksMenuItem, BackgroundTasksPanel } from "@/routes/window/chat/BackgroundTasksList";
import { openThreadBeside } from "@/routes/thread-tabs/open-thread-beside";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ArchiveThreadDialog } from "./ArchiveThreadDialog";
import { ThreadLabelsSheet } from "./ThreadLabels";

/**
 * An open thread's ⋯ menu: in its page's header, and on its row in the
 * sidebar (`row`, named by the thread's title, with no list of its
 * background tasks: that opens under the page's button). Open beside opens
 * the thread as a tab of the personal agent's panel and goes there; `onLeave` runs
 * first (the phone's drawer closes). On a phone the page's menu also opens
 * the thread's labels: its header has no room for them.
 */
export function ThreadMenu({ threadId, row, onLeave }: { threadId: string; row?: { title: string }; onLeave?: () => void }) {
  const navigate = useNavigate();
  const agent = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [labelling, setLabelling] = useState(false);
  const phonePage = useIsMobile() && !row;
  // The list of its background tasks opens under this button.
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  const scope = useMemo(() => ({ type: "manager" as const, threadId }), [threadId]);
  const openBeside = () => {
    void openThreadBeside(threadId).then((shown) => {
      if (!shown) return;
      onLeave?.();
      void navigate("/agent");
    });
  };
  return (
    <>
    {/* Its menu opening closes its list: one of the two at a time. */}
    <DropdownMenu onOpenChange={(menuOpen) => { if (menuOpen) setTasksOpen(false); }}>
      <DropdownMenuTrigger asChild>
        {row ? (
          // A row's: in sight on hover or focus with a mouse, over the row's
          // end; on a touch screen always, beside the row, as tall as it and
          // touched there only (a taller touch area would reach the next row).
          <button
            type="button"
            data-slot="nav-row-menu"
            aria-label={`Actions for ${row.title}`}
            className={cn(
              "absolute top-1/2 right-0.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-faint transition-colors hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100",
              "pointer-coarse:static pointer-coarse:h-9 pointer-coarse:w-11 pointer-coarse:translate-y-0 pointer-coarse:opacity-100"
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        ) : (
          <Button ref={setMenuButton} variant="ghost" size="icon-xs" aria-label="Thread actions" className="text-chrome">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={row ? "start" : "end"}>
        {!row && <BackgroundTasksMenuItem threadId={threadId} onOpen={() => setTasksOpen(true)} />}
        <DropdownMenuItem onSelect={openBeside}>
          <PanelRight className="h-4 w-4" />
          Open beside {agent}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setRenaming(true)}>
          <Pencil className="h-4 w-4" />
          Rename
        </DropdownMenuItem>
        {phonePage && (
          <DropdownMenuItem onSelect={() => setLabelling(true)}>
            <Tag className="h-4 w-4" />
            Labels…
          </DropdownMenuItem>
        )}
        <CompactNowItem scope={scope} />
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => setArchiving(true)}>
          <Trash2 className="h-4 w-4" />
          Archive thread
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {!row && <BackgroundTasksPanel threadId={threadId} open={tasksOpen} onOpenChange={setTasksOpen} anchor={menuButton} side="bottom" align="end" />}
    {phonePage && <PhoneLabelsSheet threadId={threadId} open={labelling} onOpenChange={setLabelling} returnFocus={menuButton} />}
    {renaming && <RenameDialog threadId={threadId} onDone={() => setRenaming(false)} />}
    {archiving && <ArchiveThreadDialog threadIds={[threadId]} onDone={() => setArchiving(false)} />}
    </>
  );
}

const NO_LABELS: never[] = [];

/** The thread's labels in a sheet, read as the store holds them. */
function PhoneLabelsSheet({ threadId, open, onOpenChange, returnFocus }: {
  threadId: string; open: boolean; onOpenChange(open: boolean): void; returnFocus: HTMLElement | null;
}) {
  const labels = useManagerThreadsStore((s) => s.threads.get(threadId)?.labels ?? NO_LABELS);
  return <ThreadLabelsSheet threadId={threadId} labels={labels} open={open} onOpenChange={onOpenChange} returnFocus={returnFocus} />;
}

/** Rename from the menu: the phone has no title to click. */
function RenameDialog({ threadId, onDone }: { threadId: string; onDone: () => void }) {
  const title = useManagerThreadsStore((s) => s.threads.get(threadId)?.title ?? "");
  const rename = useManagerThreadsStore((s) => s.rename);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const next = draft.trim();
    if (!next || next === title) { onDone(); return; }
    setBusy(true);
    const r = await rename(threadId, next);
    setBusy(false);
    if ("error" in r) toast.error(r.error);
    else onDone();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader><DialogTitle className="text-base">Rename thread</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input
            id="thread-rename"
            aria-label="Thread title"
            autoFocus
            maxLength={80}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
            <Button type="submit" disabled={busy || !draft.trim()}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
