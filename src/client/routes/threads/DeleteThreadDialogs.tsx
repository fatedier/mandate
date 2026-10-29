import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { threadHref } from "@/lib/feature-href";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { ArchivedThreadDto } from "@shared/api/agents";

const KEPT = "Worktrees and branches still on disk are left as they are. This can’t be undone.";

const canvases = (n: number) => (n === 1 ? "1 canvas" : `${n} canvases`);

/** Deleting one archived thread: what goes with it, then Home. */
export function DeleteThreadDialog({ thread, onDone }: { thread: ArchivedThreadDto; onDone: () => void }) {
  const navigate = useNavigate();
  const deleteArchived = useManagerThreadsStore((s) => s.deleteArchived);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    const result = await deleteArchived(thread.id);
    setBusy(false);
    if ("error" in result) { toast.error(result.error); return; }
    onDone();
    navigate("/home");
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDone(); }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-base">Delete “{thread.title}” permanently?</DialogTitle>
          <DialogDescription>This removes, for good:</DialogDescription>
        </DialogHeader>
        <ul data-slot="delete-list" className="list-disc pl-5 text-sm text-muted-foreground">
          <li>the thread’s conversation</li>
          {thread.workers > 0 && (
            <li>{thread.workers === 1 ? "its worker, with its chat and plan" : `its ${thread.workers} workers, with their chats and plans`}</li>
          )}
          {thread.canvases > 0 && <li>{canvases(thread.canvases)}</li>}
        </ul>
        <p className="text-sm text-muted-foreground">{KEPT}</p>
        <DialogFooter className="mt-1">
          <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Deleting…" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Deleting every archived thread at once. One still stopping is left, and
 *  said so. */
export function DeleteArchivedThreadsDialog({ threads, onDone }: { threads: ArchivedThreadDto[]; onDone: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const deleteAllArchived = useManagerThreadsStore((s) => s.deleteAllArchived);
  const [busy, setBusy] = useState(false);
  const count = threads.length;
  const workers = threads.reduce((sum, t) => sum + t.workers, 0);
  const canvasCount = threads.reduce((sum, t) => sum + t.canvases, 0);
  const parts = [
    count === 1 ? "the thread’s conversation" : "every archived thread’s conversation",
    ...(workers > 0 ? [workers === 1 ? "1 worker with its chat and plan" : `${workers} workers with their chats and plans`] : []),
    ...(canvasCount > 0 ? [canvases(canvasCount)] : [])
  ];
  const what = parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  const confirm = async () => {
    setBusy(true);
    const result = await deleteAllArchived();
    setBusy(false);
    if ("error" in result) { toast.error(result.error); return; }
    if (result.skipped > 0) {
      toast.message(result.skipped === 1
        ? "1 thread was left: its work is still stopping. Try again in a moment."
        : `${result.skipped} threads were left: their work is still stopping. Try again in a moment.`);
    }
    onDone();
    // The page of one of them has nothing left to show.
    if (threads.some((t) => pathname === threadHref(t.id))) navigate("/home");
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDone(); }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-base">
            {count === 1 ? "Delete the archived thread permanently?" : `Delete all ${count} archived threads permanently?`}
          </DialogTitle>
          <DialogDescription>This removes, for good, {what}.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Open threads are not touched. {KEPT}</p>
        <DialogFooter className="mt-1">
          <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Deleting…" : count === 1 ? "Delete 1 thread" : `Delete ${count} threads`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
