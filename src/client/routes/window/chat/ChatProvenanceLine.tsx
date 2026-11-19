import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { ThreadReplyPeek } from "@/routes/personal/ThreadReplyPeek";
import type { ChatProvenance } from "./chatProvenance";
import { CauseDetails } from "./CauseDetails";

interface ChatProvenanceLineProps {
  provenance: ChatProvenance;
  grouped?: boolean;
  /** What follows the label and stays whole while the label's words give
   *  way: a run's count, which opens it (NoticeRunLine). */
  more?: ReactNode;
}

export function ChatProvenanceLine({ provenance, grouped = false, more }: ChatProvenanceLineProps) {
  const Icon = provenance.icon;
  // No clock on the line: the transcript's dividers show the time, and the
  // row's own shows on hover (RowFrame). No title either: what is behind the
  // line opens from it (facts), never the message the model read.

  // A name that opens what its thread said is a control: on a touch screen it
  // takes the line's whole height, and the line grows to hold it.
  const peek = provenance.subject?.href && provenance.subject.reply
    ? { title: provenance.subject.text, href: provenance.subject.href, reply: provenance.subject.reply }
    : null;

  return (
    <div
      className={cn(
        "flex h-6 min-w-0 items-center gap-2 px-1 text-2xs text-faint",
        grouped ? "my-0" : "my-0.5",
        (peek || provenance.facts || more) && "pointer-coarse:h-11"
      )}
    >
      {provenance.facts && !peek ? (
        <CauseDetails provenance={provenance} facts={provenance.facts}>
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span data-slot="provenance-label" className="min-w-0 truncate font-medium text-chrome group-hover/cause:underline">
            {provenance.subject && <>{provenance.subject.code ? <code className="font-mono font-normal">{provenance.subject.text}</code> : provenance.subject.text}{" · "}</>}
            {provenance.label}
          </span>
          {provenance.detail && <span data-slot="provenance-detail" className="min-w-0 flex-1 truncate">{provenance.detail}</span>}
        </CauseDetails>
      ) : <>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {/* What happened, in words, then the detail. On a narrow line the
          detail gives way first, then the name, then how it stopped; what
          follows the words (a run's count) never does. Nothing wraps. */}
      <span data-slot="provenance-label" className="flex min-w-0 items-center font-medium text-chrome">
        {peek
          ? <ThreadReplyPeek title={peek.title} href={peek.href} reply={peek.reply} />
          : provenance.subject && <span className="min-w-0 shrink-[10000] truncate">{subjectOf(provenance.subject)}</span>}
        <span className="min-w-0 truncate whitespace-pre">{(peek || provenance.subject) && " · "}{provenance.label}</span>
      </span>
      {/* After the label in either kind of line, so it stays the same
          element when the line changes kind (NoticeRunLine's count). */}
      {more}
      {provenance.detail && (
        <span data-slot="provenance-detail" className="min-w-0 flex-1 truncate">
          {provenance.detail}
        </span>
      )}
      </>}
    </div>
  );
}

/** What a line is about: a link where it can be opened, a command as code. */
function subjectOf(subject: NonNullable<ChatProvenance["subject"]>): ReactNode {
  if (subject.href) {
    return (
      <Link
        to={subject.href}
        data-slot="provenance-link"
        className="rounded-xs hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {subject.text}
      </Link>
    );
  }
  return subject.code ? <code className="font-mono font-normal">{subject.text}</code> : subject.text;
}
