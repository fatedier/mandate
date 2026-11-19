import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { LoadingLine } from "@/components/ViewState";
import { ReplyPeek } from "@/components/ReplyPeek";
import { Button } from "@/components/ui/button";
import { formatClockMinutes } from "@/lib/format";
import type { NoticeReplyRef } from "@/routes/window/chat/chatProvenance";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { THREAD_NOTICE_LABEL } from "@shared/thread-notice";
import { noticeReplyOf } from "./notice-reply";

// On a touch screen the name is 44px to touch, by its own box: its text
// truncates inside it, so the box clips nothing of itself. On its notice's
// line the name gives way before how the thread stopped.
const NAME_CLASS = "flex min-w-0 shrink-[10000] items-center rounded-xs hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11 pointer-coarse:min-w-11";

/** The name on a notice's line. The agent's page shows what the agent said
 *  about a thread that stopped, not what the thread said: the name opens
 *  that reply in place, the one this notice brought, and going to the
 *  thread is a button inside. A box at the name; on a phone, the sheet, with
 *  the button in its header, since a sheet's body does not scroll until it
 *  is pulled up. */
export function ThreadReplyPeek({ title, href, reply }: { title: string; href: string; reply: NoticeReplyRef }) {
  const handoffs = usePersonalAgentStore((s) => s.handoffs);
  const said = noticeReplyOf(reply.handoffIds, handoffs);
  const at = said.state === "loading" ? "" : formatClockMinutes(said.at);
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
        {reply.kind === "worker" ? "Open worker" : "Open thread"}
        <ChevronRight aria-hidden />
      </Link>
    </Button>
  );
  return (
    <ReplyPeek
      slot="thread-reply"
      title={title}
      state={[THREAD_NOTICE_LABEL[reply.stop], at].filter(Boolean).join(" · ")}
      body={body}
      action={go}
      trigger={(props) => <button type="button" data-slot="notice-name" className={NAME_CLASS} {...props}><span className="truncate">{title}</span></button>}
    />
  );
}
