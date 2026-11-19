import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { LabelChip, LabelField } from "@/components/LabelField";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useKnownLabels } from "@/lib/known-labels";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { ThreadLabelDto } from "@shared/api/agents";

/** How many labels a thread's header shows before it counts the rest. */
const SHOWN = 3;

/** A thread's labels as chips, the agent's marked. */
export function ThreadLabelChips({ labels, max, chipClassName, chipSlot = "thread-label" }: {
  labels: readonly ThreadLabelDto[]; max?: number; chipClassName?: string;
  /** The chips' slot: a copy drawn only to be measured names itself apart. */
  chipSlot?: string;
}) {
  const agentName = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const shown = max === undefined ? labels : labels.slice(0, max);
  const more = labels.length - shown.length;
  return (
    <>
      {shown.map((label) => <LabelChip key={label.name} label={label} agentName={agentName} slot={chipSlot} className={chipClassName} />)}
      {more > 0 && <span data-slot="thread-label-more" className="shrink-0 text-2xs text-faint">+{more}</span>}
    </>
  );
}

/** The field that edits a thread's labels, open or archived: what it adds
 *  and removes goes to the server, and a refusal is said. */
function ThreadLabelField({ threadId, labels, autoFocus }: { threadId: string; labels: readonly ThreadLabelDto[]; autoFocus?: boolean }) {
  const known = useKnownLabels();
  const agentName = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const said = (result: { ok: true } | { error: string }) => { if ("error" in result) toast.error(result.error); };
  return (
    <LabelField
      slot="thread"
      labels={labels}
      known={known}
      agentName={agentName}
      autoFocus={autoFocus}
      onAdd={(name) => { void useManagerThreadsStore.getState().addLabel(threadId, name).then(said); }}
      onRemove={(name) => { void useManagerThreadsStore.getState().removeLabel(threadId, name).then(said); }}
    />
  );
}

/**
 * A thread's labels in its header: up to three chips, then how many more,
 * and a + that adds one. The chips or the + open the field that edits them
 * in place.
 */
export function ThreadLabels({ threadId, labels }: { threadId: string; labels: readonly ThreadLabelDto[] }) {
  const [open, setOpen] = useState(false);
  const chipsRef = useRef<HTMLButtonElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span data-slot="thread-labels" className="flex min-w-0 shrink items-center gap-1">
          {labels.length > 0 && (
            <button ref={chipsRef} type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)} className="flex min-w-0 shrink items-center gap-1 overflow-hidden rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <ThreadLabelChips labels={labels} max={SHOWN} />
            </button>
          )}
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Add a label"
              title="Add a label"
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-faint transition-colors hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-sel data-[state=open]:text-foreground"
            >
              <Plus aria-hidden className="size-3.5" />
            </button>
          </PopoverTrigger>
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-72 px-2 py-1"
        // A press on the chips is theirs to toggle, as the + trigger's is:
        // counted as outside, it closed the field and its click opened it again.
        onInteractOutside={(event) => { if (chipsRef.current?.contains(event.target as Node)) event.preventDefault(); }}
      >
        <ThreadLabelField threadId={threadId} labels={labels} autoFocus />
      </PopoverContent>
    </Popover>
  );
}

/** The same field in a sheet, for a phone: opened from the thread's menu,
 *  whose button gets focus back when the sheet closes (`returnFocus`: the
 *  menu item that opened it is gone by then). */
export function ThreadLabelsSheet({ threadId, labels, open, onOpenChange, returnFocus }: {
  threadId: string;
  labels: readonly ThreadLabelDto[];
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus?: HTMLElement | null;
}) {
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      slot="thread-labels-sheet"
      bodyClassName="px-4 pb-4"
      header={<div className="flex h-8 items-center px-4"><BottomSheetTitle className="text-sm font-semibold">Labels</BottomSheetTitle></div>}
    >
      <ThreadLabelField threadId={threadId} labels={labels} />
    </BottomSheet>
  );
}
