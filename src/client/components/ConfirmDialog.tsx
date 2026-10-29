import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConfirmStore } from "@/components/confirm-action";

export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);
  const resolve = useConfirmStore((s) => s.resolve);
  const open = pending !== null;
  const confirmLabel = pending?.confirmLabel
    ?? (pending?.destructive ? "Delete" : "Confirm");
  const cancelLabel = pending?.cancelLabel ?? "Cancel";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resolve(false); }}>
      <DialogContent
        data-confirm-dialog=""
        showCloseButton={false}
        className="sm:max-w-[440px]"
        // Radix gives focus back to what had it once the dialog mounted:
        // the autofocused confirm button, gone by now — so focus fell to the
        // page. The question remembers what had it when it was asked.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const { pending, returnFocus } = useConfirmStore.getState();
          // A follow-up is open: focus goes back when that one closes.
          if (pending) return;
          useConfirmStore.setState({ returnFocus: null });
          if (returnFocus?.isConnected) returnFocus.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-base">{pending?.title ?? ""}</DialogTitle>
          {pending?.description && (
            <DialogDescription className="whitespace-pre-line">
              {pending.description}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => resolve(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={pending?.destructive ? "destructive" : "default"}
            onClick={() => resolve(true)}
            // autoFocus so Enter triggers confirm. Pairs with focus-visible
            // styling on Button so mobile / programmatic focus doesn't show
            // a stuck ring.
            autoFocus
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
