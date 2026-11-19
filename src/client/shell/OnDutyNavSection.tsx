import { useMemo } from "react";
import { useNow } from "@/hooks/useNow";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadDots } from "@/hooks/useThreadDots";
import { dutyMark, dutyRowEnd } from "@/lib/duty";
import { ThreadNavRow } from "./ThreadsNavSection";

/** The duty threads the owner put in the sidebar, in the order they were put
 *  there, above the others: each says when it is checked next. Rows join or
 *  leave only by the owner's hand (the On duty page); a check's state moves
 *  only a row's mark. */
export function OnDutyNavSection({ onNavigate }: { onNavigate?: () => void }) {
  const threads = useManagerThreadsStore((s) => s.threads);
  const dots = useThreadDots();
  const rows = useMemo(
    () => [...threads.values()]
      .filter((t) => t.duty?.sidebarAddedAt)
      .sort((a, b) => a.duty!.sidebarAddedAt!.localeCompare(b.duty!.sidebarAddedAt!) || a.id.localeCompare(b.id)),
    [threads]
  );
  // A due time today reads as its clock, another day's as its date.
  const now = useNow();
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col">
      <div aria-hidden className="flex h-7 shrink-0 items-center px-2 pt-3 select-none">
        <span className="label-group">On duty</span>
      </div>
      <div role="group" aria-label="On duty" className="relative flex flex-col gap-0.5">
        {rows.map((t) => {
          const end = dutyRowEnd(t.duty!, now);
          return (
            <ThreadNavRow
              key={t.id}
              thread={t}
              dot={dutyMark(t, dots.get(t.id) ?? "idle")}
              onNavigate={onNavigate}
              end={end && <span data-slot="duty-next" className="ml-auto shrink-0 text-2xs tabular-nums text-faint">{end}</span>}
            />
          );
        })}
      </div>
    </div>
  );
}
