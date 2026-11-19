import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/**
 * A thumbnail that opens its image in place, over the page, as large as the
 * window allows (never larger than it is). Not a new tab: Chrome refuses to
 * load a `data:` URL a page opens there, and the tab stays blank until
 * reloaded. The shared dialog closes it on Esc and on the phone's Back; ×
 * and a click beside the picture close it too. On a phone it is the screen's
 * width on black, and the page's own pinch zooms it; × and the picture
 * keep clear of its safe areas (the app runs under the status bar).
 */
export function ImageViewer({ src, alt, label, className, children }: {
  src: string;
  alt: string;
  /** The thumbnail button's name, where its content holds more than the
   *  picture (a control inside it would be read into it). */
  label?: string;
  /** The thumbnail button's. */
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ImageLightbox
      open={open}
      onOpenChange={setOpen}
      src={src}
      alt={alt}
      trigger={(
        <button type="button" data-slot="image-open" title={alt} aria-label={label} className={className}>
          {children}
        </button>
      )}
    />
  );
}

/** Where a picture is among others shown with it (a report's), and the way
 *  to the one before or after; the caller wraps round. */
export interface LightboxPaging {
  index: number;
  count: number;
  caption: string;
  onStep: (delta: 1 | -1) => void;
}

/**
 * The picture over the page: the whole window, the picture fitted, × / Esc /
 * a press beside it close it, the phone's Back too. With paging (more than
 * one picture), ‹ and › at its sides and ← → step, and the bottom says where
 * it is ("3 / 7 · caption").
 */
export function ImageLightbox({ open, onOpenChange, src, alt, paging, trigger, returnFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  alt: string;
  paging?: LightboxPaging;
  /** What opens it, when it is a button on the page (a thumbnail): focus
   *  goes back to it when the picture closes. */
  trigger?: ReactNode;
  /** Opened from something with no trigger (a report's frame): where focus
   *  goes back when the picture closes, so its keys work again. */
  returnFocus?: () => HTMLElement | null;
}) {
  const paged = paging && paging.count > 1 ? paging : null;
  // On a phone the picture fills the width and the arrows sit on it: a dark
  // ground keeps them seen over a light screenshot.
  const side = "hit absolute top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none max-sm:bg-black/55 max-sm:hover:bg-black/70";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // The dialog fills the window; the picture sits in its middle. A
        // click that lands on the dialog itself landed beside the picture.
        onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}
        onCloseAutoFocus={(event) => {
          const back = returnFocus?.();
          if (!back) return;
          event.preventDefault();
          back.focus();
        }}
        onKeyDown={(event) => {
          if (!paged || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          paged.onStep(event.key === "ArrowRight" ? 1 : -1);
        }}
        className="inset-0 flex max-h-none max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden rounded-none border-0 bg-black/40 px-6 pt-[calc(env(safe-area-inset-top,0px)+3.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+3.5rem)] shadow-none sm:max-w-none sm:px-14 max-sm:bg-black/85 max-sm:px-0"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {/* Keyed: another picture is a new element, so the last one never
            shows under the new position while it loads. */}
        <img key={src} src={src} alt={alt} className="min-h-0 min-w-0 max-h-full max-w-full rounded-md object-contain max-sm:rounded-none" />
        {paged && (
          <>
            <button type="button" aria-label="Previous picture" title="Previous picture" onClick={() => paged.onStep(-1)} className={`${side} left-[calc(env(safe-area-inset-left,0px)+0.75rem)]`}>
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <button type="button" aria-label="Next picture" title="Next picture" onClick={() => paged.onStep(1)} className={`${side} right-[calc(env(safe-area-inset-right,0px)+0.75rem)]`}>
              <ChevronRight className="size-5" aria-hidden />
            </button>
            <span
              data-slot="lightbox-count"
              className="num absolute bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-black/40 px-3 py-1 text-xs text-white"
            >
              {`${paged.index + 1} / ${paged.count}${paged.caption ? ` · ${paged.caption}` : ""}`}
            </span>
          </>
        )}
        <DialogPrimitive.Close
          aria-label="Close"
          className="hit absolute top-[calc(env(safe-area-inset-top,0px)+0.75rem)] right-[calc(env(safe-area-inset-right,0px)+0.75rem)] flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
        >
          <XIcon className="size-4" aria-hidden />
        </DialogPrimitive.Close>
      </DialogContent>
    </Dialog>
  );
}
