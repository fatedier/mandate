import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSideChatsStore } from "@/store/side-chats";
import { errorText } from "@shared/error-text";

/** What a confirm or the Send dialog adds while a command of the side
 *  chat's still runs. */
export const COMMAND_STOPS = "A command still running here stops.";

type SummaryState = { kind: "writing" } | { kind: "written"; text: string } | { kind: "failed"; error: string };

/** Send to the agent: the summary is written as the dialog opens and shown
 *  in it, the user may add a note, and Send posts both; Cancel drops the
 *  draft. `onDone(true)` once it went. */
export function SendSideChatDialog({ chatId, name, commandRunning, onDone }: {
  chatId: string;
  name: string;
  commandRunning: boolean;
  onDone: (sent: boolean) => void;
}) {
  const [summary, setSummary] = useState<SummaryState>({ kind: "writing" });
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState(0);
  const write = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    write.current = controller;
    useSideChatsStore.getState().summary(chatId, controller.signal).then(
      (text) => { if (!controller.signal.aborted) setSummary({ kind: "written", text }); },
      (err: unknown) => { if (!controller.signal.aborted) setSummary({ kind: "failed", error: errorText(err) }); }
    );
    return () => controller.abort();
  }, [chatId, asked]);
  const again = useCallback(() => { setSummary({ kind: "writing" }); setAsked((n) => n + 1); }, []);
  const send = async () => {
    if (summary.kind !== "written") return;
    setSending(true);
    try {
      await useSideChatsStore.getState().send(chatId, summary.text, note);
      onDone(true);
    } catch (err) {
      toast.error(`Could not send: ${errorText(err)}`);
      setSending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !sending) onDone(false); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base">Send to {name}</DialogTitle>
          <DialogDescription>{name} gets this summary and your note, and the whole side chat as a file. The side chat then closes.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[40vh] min-h-16 overflow-y-auto rounded-md border border-border-soft bg-muted/30 px-3 py-2 text-sm">
          {summary.kind === "writing" && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              Writing the summary…
            </p>
          )}
          {summary.kind === "written" && <p data-slot="side-chat-summary" className="whitespace-pre-wrap text-foreground">{summary.text}</p>}
          {summary.kind === "failed" && (
            <div className="flex items-start justify-between gap-2">
              <p className="text-destructive">Could not write the summary: {summary.error}</p>
              <Button type="button" variant="ghost" size="sm" onClick={again} className="h-7 shrink-0 px-2 text-xs">Try again</Button>
            </div>
          )}
        </div>
        <textarea
          placeholder={`Add a note for ${name} (optional)`}
          value={note}
          disabled={sending}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-md border border-border-soft bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        {commandRunning && <p className="text-xs text-muted-foreground">{COMMAND_STOPS}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={sending} onClick={() => onDone(false)}>Cancel</Button>
          <Button type="button" disabled={sending || summary.kind !== "written"} onClick={() => void send()}>Send to {name}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
