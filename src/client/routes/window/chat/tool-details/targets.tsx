import { cn } from "@/lib/utils";
import { DetailSection } from "./blocks";
import { useNameLookup } from "./names-context";

/** What a call acted on, by name when the transcript gave it one: "dev
 *  server %4". Without a name, the id alone — never a guessed name. */
function TargetLine({ name, id, note }: { name: string | null; id: string; note?: string }) {
  return (
    <div data-slot="tool-target" className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-sm bg-code-bg p-2">
      {name && <span data-slot="tool-target-name" className="text-xs font-semibold text-foreground">{name}</span>}
      <span data-slot="tool-target-id" className={cn("font-mono text-2xs", name ? "text-faint" : "text-foreground")}>{id}</span>
      {note && <span data-slot="tool-target-note" className="ml-auto text-2xs text-faint">{note}</span>}
    </div>
  );
}

export type TargetKind = "pane" | "feature";

const TARGET_LABEL: Record<TargetKind, string> = { pane: "Pane", feature: "Worker" };

/** A pane or feature a call acted on, as its own section. A pane's name is
 *  the one its lifetime had when this call acted on it (`callId`). */
export function TargetSection({ kind, id, callId, note }: { kind: TargetKind; id: string; callId: string; note?: string }) {
  const names = useNameLookup();
  return (
    <DetailSection label={TARGET_LABEL[kind]} copyText={id}>
      <TargetLine name={kind === "pane" ? names.pane(callId) : names.feature(id)} id={id} note={note} />
    </DetailSection>
  );
}
