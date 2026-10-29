import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { ThreadReplyPeek } from "@/routes/global/ThreadReplyPeek";
import type { ChatProvenance } from "./chatProvenance";
import { CauseDetails } from "./CauseDetails";

interface ChatProvenanceLineProps {
  provenance: ChatProvenance;
  grouped?: boolean;
}

export function ChatProvenanceLine({ provenance, grouped = false }: ChatProvenanceLineProps) {
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
        (peek || provenance.facts) && "pointer-coarse:h-11"
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
      {/* What happened, in words, then the detail. The label keeps its width
          as long as it can and the detail gives way first; both truncate
          rather than wrap. */}
      {peek ? (
        // The name truncates by itself and how it stopped stays whole: a
        // label that clipped as one would cut the name's touch area with it.
        <span data-slot="provenance-label" className="flex min-w-0 items-center font-medium text-chrome">
          <ThreadReplyPeek title={peek.title} href={peek.href} reply={peek.reply} />
          <span className="shrink-0 whitespace-pre"> · {provenance.label}</span>
        </span>
      ) : (
        <span data-slot="provenance-label" className="min-w-0 truncate font-medium text-chrome">
          {provenance.subject && (
            <>
              {provenance.subject.href ? (
                <Link
                  to={provenance.subject.href}
                  data-slot="provenance-link"
                  className="rounded-xs hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {provenance.subject.text}
                </Link>
              ) : provenance.subject.code ? <code className="font-mono font-normal">{provenance.subject.text}</code> : provenance.subject.text}
              {" · "}
            </>
          )}
          {provenance.label}
        </span>
      )}
      {provenance.detail && (
        <span data-slot="provenance-detail" className="min-w-0 flex-1 truncate">
          {provenance.detail}
        </span>
      )}
      </>}
    </div>
  );
}
