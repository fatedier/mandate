import { useMemo } from "react";
import { Link } from "react-router";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadDots } from "@/hooks/useThreadDots";
import { useNow } from "@/hooks/useNow";
import { dutyHomeLine, dutyMark, dutyNeedsLook, dutyOrder } from "@/lib/duty";
import { threadHref } from "@/lib/worker-href";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { cn } from "@/lib/utils";

/** Under what waits on you, the duty threads that need a look (a report
 *  unread, or a check failing): when each is checked next and how often so
 *  far, each opening its thread; then the way to all of them. */
export function OnDuty() {
  const threads = useManagerThreadsStore((s) => s.threads);
  const dots = useThreadDots();
  const all = useMemo(() => dutyOrder(threads.values()), [threads]);
  // Home is what waits on the owner: the duty threads that need a look, in
  // the page's order; the rest are a press away.
  const rows = all.filter(dutyNeedsLook);
  const now = useNow();
  if (all.length === 0) return null;
  return (
    <section aria-label="On duty" className="flex flex-col gap-2">
      <h2 className="label-group">On duty</h2>
      <div className="flex flex-col overflow-hidden rounded-xl border border-border-soft">
        {rows.map((t, i) => (
          <Link
            key={t.id}
            to={threadHref(t.id)}
            data-duty-thread={t.id}
            className={cn("flex min-h-12 items-center gap-3 px-3 py-2 hover:bg-sel pointer-coarse:min-h-14", i > 0 && "border-t border-border-soft")}
          >
            <ThreadStateMark dot={dutyMark(t, dots.get(t.id) ?? "idle")} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span data-slot="duty-title" className="min-w-0 truncate text-sm font-semibold text-foreground">{t.title}</span>
              <span data-slot="duty-line" className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">{dutyHomeLine(t.duty!, now)}</span>
            </span>
          </Link>
        ))}
        <Link
          to="/duty"
          data-slot="duty-all"
          className={cn("flex min-h-10 items-center px-3 py-2 text-xs text-muted-foreground hover:bg-sel hover:text-foreground", rows.length > 0 && "border-t border-border-soft")}
        >
          {`All ${all.length} on duty`}
        </Link>
      </div>
    </section>
  );
}
