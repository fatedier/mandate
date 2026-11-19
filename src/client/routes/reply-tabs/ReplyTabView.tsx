import { MarkdownView } from "@/components/MarkdownView";
import { formatClockMinutes, formatDateTimeTitle } from "@/lib/format";
import type { ReplyTabDto } from "@shared/api-contracts";
import { cn } from "@/lib/utils";

/** A reply opened in the right panel, drawn as the chat draws it, from the
 *  copy the tab keeps (the chat need not have it loaded). Its bar says when
 *  it was written; the tab's Close removes it. */
export function ReplyTabView({ tab, shown = true }: { tab: ReplyTabDto; shown?: boolean }) {
  return (
    // Hidden, not unmounted, behind another tab: it keeps its scroll.
    <div data-slot="reply-tab-view" data-reply-tab={tab.id} className={cn("min-h-0 flex-1 flex-col", shown ? "flex" : "hidden")}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft pl-3 pr-2">
        <h2 className="shrink-0 text-sm font-semibold text-foreground">Reply</h2>
        <time dateTime={tab.repliedAt} title={formatDateTimeTitle(tab.repliedAt) || undefined} className="num shrink-0 text-xs text-faint">
          · {formatClockMinutes(tab.repliedAt)}
        </time>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-5 py-4">
          <MarkdownView text={tab.text} />
        </div>
      </div>
    </div>
  );
}
