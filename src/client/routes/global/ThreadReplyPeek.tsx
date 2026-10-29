import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { LoadingLine } from "@/components/ViewState";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatClockMinutes } from "@/lib/format";
import type { NoticeReplyRef } from "@/routes/window/chat/chatProvenance";
import { useGlobalAgentStore } from "@/store/global-agent";
import { THREAD_NOTICE_LABEL } from "@shared/thread-notice";
import { noticeReplyOf } from "./notice-reply";

// On a touch screen the name is 44px to touch, by its own box: its text
// truncates inside it, so the box clips nothing of itself.
const NAME_CLASS = "flex min-w-0 items-center rounded-xs hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11 pointer-coarse:min-w-11";

/** The name on a notice's line. The agent's page shows what the agent said
 *  about a thread that stopped, not what the thread said: the name opens
 *  that reply in place, the one this notice brought, and going to the
 *  thread is a button inside. A box at the name; on a phone, the sheet, with
 *  the button in its header, since a sheet's body does not scroll until it
 *  is pulled up. */
export function ThreadReplyPeek({ title, href, reply }: { title: string; href: string; reply: NoticeReplyRef }) {
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
  const handoffs = useGlobalAgentStore((s) => s.handoffs);
  const said = noticeReplyOf(reply.handoffIds, handoffs);
  const at = said.state === "loading" ? "" : formatClockMinutes(said.at);

  const heading = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span data-slot="thread-reply-title" className="truncate text-sm font-semibold text-foreground">{title}</span>
      <span data-slot="thread-reply-state" className="text-2xs text-faint">{[THREAD_NOTICE_LABEL[reply.stop], at].filter(Boolean).join(" · ")}</span>
    </div>
  );
  const body: ReactNode = said.state === "loading"
    ? <LoadingLine />
    : (
      <div data-slot="thread-reply-body">
        {said.state === "said"
          ? <MarkdownView text={said.text} dense />
          : <p className="text-sm text-muted-foreground">{said.reason ?? "It stopped without a reply."}</p>}
      </div>
    );
  const go = (
    <Button asChild variant="outline" size="xs" className="shrink-0">
      <Link to={href} data-slot="thread-reply-go">
        {reply.kind === "feature" ? "Open worker" : "Open thread"}
        <ChevronRight aria-hidden />
      </Link>
    </Button>
  );

  if (phone) {
    return (
      <>
        <button type="button" data-slot="notice-name" aria-haspopup="dialog" className={NAME_CLASS} onClick={() => setOpen(true)}><span className="truncate">{title}</span></button>
        <BottomSheet
          open={open}
          onOpenChange={setOpen}
          slot="thread-reply"
          header={(
            <div className="flex items-center gap-3 border-b border-border-soft px-4 pt-1 pb-3">
              <BottomSheetTitle className="sr-only">{title}</BottomSheetTitle>
              {heading}
              {go}
            </div>
          )}
          bodyClassName="px-4 pt-3 pb-6"
        >
          {body}
        </BottomSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-slot="notice-name" className={NAME_CLASS}><span className="truncate">{title}</span></button>
      </PopoverTrigger>
      {/* As tall as the window leaves it on the side it opens to, so it flips
          upward from a line low on the page and never leaves the window. */}
      <PopoverContent
        data-slot="thread-reply"
        aria-label={title}
        collisionPadding={12}
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[28rem] max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div className="flex items-center gap-3 border-b border-border-soft px-3.5 py-2.5">{heading}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">{body}</div>
        <div className="flex justify-end border-t border-border-soft px-3.5 py-2">{go}</div>
      </PopoverContent>
    </Popover>
  );
}
