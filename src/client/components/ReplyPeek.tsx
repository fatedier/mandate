import { useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";

/** What a trigger is given on a phone, where it opens the sheet itself. */
export type ReplyPeekTriggerProps = { onClick?: (event: MouseEvent<HTMLElement>) => void; "aria-haspopup"?: "dialog" };

/**
 * A reply opened in place from a line of the conversation, without leaving
 * it: a box at the line, as tall as the window leaves it on the side it
 * opens to; on a phone, the sheet. `slot` names the box, and its title and
 * state lines (`<slot>-title`, `<slot>-state`). An `action` (a link away)
 * sits under the reply in the box, and in the sheet's header, since a
 * sheet's body does not scroll until it is pulled up; given as a function,
 * it is handed what closes the box, for an action that leaves the page as
 * it is.
 */
export function ReplyPeek({ slot, title, state, body, action, trigger }: {
  slot: string;
  title: string;
  state?: string;
  body: ReactNode;
  action?: ReactNode | ((close: () => void) => ReactNode);
  /** The control that opens it; spread the props it is given onto it. */
  trigger: (props: ReplyPeekTriggerProps) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
  // The sheet is opened by a control that is not its own trigger: focus goes
  // back to it by hand once the sheet closes.
  const [opener, setOpener] = useState<HTMLElement | null>(null);

  const heading = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span data-slot={`${slot}-title`} className="truncate text-sm font-semibold text-foreground">{title}</span>
      {state !== undefined && <span data-slot={`${slot}-state`} className="text-2xs text-faint">{state}</span>}
    </div>
  );
  const actions = typeof action === "function" ? action(() => setOpen(false)) : action;

  if (phone) {
    return (
      <>
        {trigger({ onClick: (event) => { setOpener(event.currentTarget); setOpen(true); }, "aria-haspopup": "dialog" })}
        <BottomSheet
          open={open}
          onOpenChange={setOpen}
          returnFocus={opener}
          slot={slot}
          header={(
            <div className="flex items-center gap-3 border-b border-border-soft px-4 pt-1 pb-3">
              <BottomSheetTitle className="sr-only">{title}</BottomSheetTitle>
              {heading}
              {actions}
            </div>
          )}
          bodyClassName="px-4 pt-3 pb-6"
        >
          {/* Focusable: a reply with nothing in it to tap is still reached
              from the keyboard, and focus in it raises the sheet to full
              height, where it scrolls. */}
          <div tabIndex={0} className="rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60">{body}</div>
        </BottomSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger({})}</PopoverTrigger>
      {/* As tall as the window leaves it on the side it opens to, so it flips
          upward from a line low on the page and never leaves the window. */}
      <PopoverContent
        data-slot={slot}
        aria-label={title}
        collisionPadding={12}
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[28rem] max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div className="flex items-center gap-3 border-b border-border-soft px-3.5 py-2.5">{heading}</div>
        {/* Focusable, as the sheet's reply is: one with nothing in it to tap
            is still scrolled from the keyboard. */}
        <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60">{body}</div>
        {actions && <div className="flex justify-end gap-2 border-t border-border-soft px-3.5 py-2">{actions}</div>}
      </PopoverContent>
    </Popover>
  );
}
