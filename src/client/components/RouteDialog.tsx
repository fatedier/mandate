import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { RouteDialogCloseContext } from "./route-dialog-close";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useLocation, useNavigate } from "react-router";

function pressedOnToast(event: Event): boolean {
  const original = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent?.target ?? event.target;
  return original instanceof Element && original.closest("[data-sonner-toaster]") !== null;
}

/** What a route opens over whatever it was opened from (a canvas, a file):
 *  full screen on a phone, inset from `sm`. A Radix dialog, so it joins the
 *  layers already open: drawn in the page itself it sat UNDER a phone's
 *  worker sheet (a portal at the same depth, later in the document), which
 *  also kept every tap and the focus for itself. As a layer of the same kind
 *  it is in front, takes the taps, and hands focus back when it closes. It
 *  closes by going back one step (useRouteDialogClose). */
export function RouteDialog({ label, children }: { label: string; children: ReactNode }) {
  const navigate = useNavigate();
  const content = useRef<HTMLDivElement>(null);
  // What had focus when it was opened: the row or the card pressed. Radix
  // hands focus back to a dialog's Trigger, and this dialog has none (a route
  // opens it), so it would be left on the page's body.
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  // One step back per entry, however many ways the close is asked for. Per
  // entry: one dialog serves every canvas (or file), so one opened over
  // another closes onto the first without a remount, and the first must
  // still close.
  const closing = useRef(false);
  const { key } = useLocation();
  useEffect(() => {
    closing.current = false;
  }, [key]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    navigate(-1);
  }, [navigate]);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPrimitive.Portal>
        {/* The backdrop holds the dialog, so a press beside it is a press outside it. */}
        {/* It fades in as a dialog does; it closes by going back, so it leaves
            with the page. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/55 p-0 animate-in fade-in-0 duration-200 sm:items-center sm:p-4">
          <DialogPrimitive.Content
            ref={content}
            aria-label={label}
            aria-describedby={undefined}
            // A menu or a question open over it is a layer above and takes Esc
            // first; a design's focused view takes it before any layer hears
            // it (DesignCanvasView). What is left is the dialog's, except a
            // held key's repeats after one of those.
            onEscapeKeyDown={(event) => { if (event.repeat) event.preventDefault(); }}
            onInteractOutside={(event) => { if (pressedOnToast(event)) event.preventDefault(); }}
            // On the dialog itself, which names it; not on its first button.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              content.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const from = opener.current;
              if (from instanceof HTMLElement && from.isConnected) from.focus();
            }}
            className="flex h-full w-full min-w-0 overflow-hidden bg-background shadow-2xl outline-none animate-in fade-in-0 zoom-in-[0.98] duration-200 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[1600px] sm:rounded-lg sm:border sm:border-border-soft"
          >
            <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
            <RouteDialogCloseContext.Provider value={close}>{children}</RouteDialogCloseContext.Provider>
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
