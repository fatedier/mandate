import { useMemo, useState } from "react";
import { MoreHorizontal, Pencil, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CompactNowItem } from "@/routes/window/chat/CompactNowItem";
import { BackgroundTasksMenuItem, BackgroundTasksPanel } from "@/routes/window/chat/BackgroundTasksList";
import { useSideChatsStore } from "@/store/side-chats";
import { errorText } from "@shared/error-text";
import type { SideChatDto } from "@shared/api/side-chat";

/** A side chat's ⋯, as a thread's: its background tasks once it has started
 *  one, Rename and Compact now, and Discard (an end that cannot be undone,
 *  never on the header beside Send); on a phone, where the header has no
 *  room for it, Send too. */
export function SideChatMenu({ chat, phone, name, onSend, onDiscard }: {
  chat: SideChatDto;
  phone: boolean;
  name: string;
  onSend: () => void;
  onDiscard: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  const scope = useMemo(() => ({ type: "side_chat" as const, threadId: chat.id }), [chat.id]);
  return (
    <>
      {/* Its menu opening closes the list: one of the two at a time. */}
      <DropdownMenu onOpenChange={(menuOpen) => { if (menuOpen) setTasksOpen(false); }}>
        <DropdownMenuTrigger asChild>
          <Button ref={setMenuButton} variant="ghost" size="icon-xs" aria-label="Side chat actions" className="text-chrome">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <BackgroundTasksMenuItem threadId={chat.id} onOpen={() => setTasksOpen(true)} />
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil className="h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <CompactNowItem scope={scope} />
          <DropdownMenuSeparator />
          {phone && (
            <DropdownMenuItem onSelect={onSend}>
              <Send className="h-4 w-4" />
              Send to {name}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={onDiscard}>
            <Trash2 className="h-4 w-4" />
            Discard side chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BackgroundTasksPanel threadId={chat.id} open={tasksOpen} onOpenChange={setTasksOpen} anchor={menuButton} side="bottom" align="end" />
      {renaming && <RenameSideChatDialog chat={chat} onDone={() => setRenaming(false)} />}
    </>
  );
}

/** Rename, as a thread is renamed from its menu. */
function RenameSideChatDialog({ chat, onDone }: { chat: SideChatDto; onDone: () => void }) {
  const [draft, setDraft] = useState(chat.named ? chat.title : "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const next = draft.trim();
    if (!next || (chat.named && next === chat.title)) { onDone(); return; }
    setBusy(true);
    try {
      await useSideChatsStore.getState().rename(chat.id, next);
      onDone();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader><DialogTitle className="text-base">Rename side chat</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input
            aria-label="Side chat title"
            autoFocus
            maxLength={80}
            value={draft}
            placeholder={chat.named ? undefined : chat.title}
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
