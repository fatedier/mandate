import { formatClockTime, formatDateTimeTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChatProvenance } from "./chatProvenance";

interface ChatProvenanceLineProps {
  provenance: ChatProvenance;
  grouped?: boolean;
}

export function ChatProvenanceLine({ provenance, grouped = false }: ChatProvenanceLineProps) {
  const time = provenance.createdAt ? formatClockTime(provenance.createdAt) : null;
  const Icon = provenance.icon;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 px-2 py-1 text-2xs text-muted-foreground",
        grouped ? "my-0" : "my-1"
      )}
      title={provenance.title}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {/* The label stays at every width: five icons carry eleven labels
          (`Activity` serves HEARTBEAT / FEATURE / WORK ITEM, `Bell` serves
          ALARM / WATCH), so the icon cannot identify the event on its own. */}
      <span data-slot="provenance-label" className="shrink-0 label-micro text-foreground/70">
        {provenance.label}
      </span>
      {/* Narrow only: the chip goes, because it is the redundant one. The row's
          furniture (label + chip + clock) is a fixed width whatever the panel
          does, so `detail` — the only part that varies — is the only part that
          pays for a narrow dock: it measured 0px at a 320px dock and was still
          truncated at the dock's 480px default. CONTEXT appears with both
          `runtime_context` and `compression`, which makes the chip look
          essential, but what actually tells those apart is the detail
          ("initial snapshot" versus "compressed 24 earlier messages") — the very
          thing the chip is crowding out.

          What the source costs: it remains only in the row's `title`, which is a
          hover affordance, so below the threshold it is NOT available on touch —
          and that is the band phones are in. Accepted deliberately: label and
          detail together recover it in practice (`CONTEXT` + "compressed 24
          earlier messages" versus `CONTEXT` + "initial snapshot"), and that
          redundancy is the whole reason the chip was the thing to cut rather
          than the label. Do not restate this as "reachable on long-press";
          `title` does not reliably surface on touch.

          Every class outside the variant is the wide chip exactly as it has
          always been, so wide is unaffected by construction rather than by
          measurement; a plain `hidden` here would delete the chip outright
          instead. Nothing here may gain a min-width `@[34rem]:` variant; a test
          pins that, as it does on the tool row. */}
      <span
        data-slot="provenance-source"
        className="shrink-0 rounded-xs border border-border/70 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground @max-[34rem]:hidden"
      >
        [{provenance.source}]
      </span>
      {/* The part every other decision in this row is made to protect: it is
          the only part whose width varies, so it is the only part that can pay
          for a narrow dock. It may yield space (`min-w-0`, `truncate`); it may
          never be hidden at any width — a test pins that positively, because
          banning the wrong variants proves nothing about what remains. */}
      <span data-slot="provenance-detail" className="min-w-0 truncate">
        {provenance.detail}
      </span>
      {time ? (
        <time
          className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground"
          dateTime={provenance.createdAt}
          title={provenance.createdAt ? formatDateTimeTitle(provenance.createdAt) : undefined}
        >
          {time}
        </time>
      ) : null}
    </div>
  );
}
