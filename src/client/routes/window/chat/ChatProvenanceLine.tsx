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
        "flex h-6 min-w-0 items-center gap-2 px-1 text-2xs text-faint",
        grouped ? "my-0" : "my-0.5"
      )}
      title={provenance.title}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {/* The label stays at every width: five icons carry eleven labels
          (`Activity` serves HEARTBEAT / FEATURE / WORK ITEM, `Bell` serves
          ALARM / WATCH), so the icon cannot identify the event on its own. */}
      <span data-slot="provenance-label" className="shrink-0 label-micro">
        {provenance.label}
      </span>
      {/* The detail is the only part whose width varies, so it is the only part
          that may yield (`min-w-0`, `truncate`); it is never hidden. The old
          `[source]` chip is gone at every width: what told CONTEXT/runtime
          apart from CONTEXT/compression was this detail, not the chip. */}
      <span data-slot="provenance-detail" className="min-w-0 truncate">
        {provenance.detail}
      </span>
      {time ? (
        <time
          className="ml-auto shrink-0 text-2xs tabular-nums"
          dateTime={provenance.createdAt}
          title={provenance.createdAt ? formatDateTimeTitle(provenance.createdAt) : undefined}
        >
          {time}
        </time>
      ) : null}
    </div>
  );
}
