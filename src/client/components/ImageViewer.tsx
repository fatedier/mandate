import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
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
export function ImageViewer({ src, alt, className, children }: {
  src: string;
  alt: string;
  /** The thumbnail button's. */
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" data-slot="image-open" title={alt} className={className}>
          {children}
        </button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // The dialog fills the window; the picture sits in its middle. A
        // click that lands on the dialog itself landed beside the picture.
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        className="inset-0 flex max-h-none max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden rounded-none border-0 bg-black/40 px-6 pt-[calc(env(safe-area-inset-top,0px)+3.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+3.5rem)] shadow-none sm:max-w-none sm:px-14 max-sm:bg-black/85 max-sm:px-0"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img src={src} alt={alt} className="min-h-0 min-w-0 max-h-full max-w-full rounded-md object-contain max-sm:rounded-none" />
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
