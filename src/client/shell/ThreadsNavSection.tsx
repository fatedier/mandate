import { useMemo, useRef, type ReactNode } from "react";
import { useSlideOnReorder } from "@/hooks/useSlideOnReorder";
import { NavLink } from "react-router";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { ThreadDot } from "@shared/thread-dot";
import { useThreadDots } from "@/hooks/useThreadDots";
import { isThreadNew, sortThreadsForSidebar } from "@/lib/thread-dot";
import { ThreadStateMark } from "./ThreadStateMark";
import { threadHref } from "@/lib/worker-href";
import { ThreadMenu } from "@/routes/threads/ThreadMenu";
import { cn } from "@/lib/utils";


export function ThreadsNavSection({ onNavigate }: { onNavigate?: () => void }) {
  const threads = useManagerThreadsStore((s) => s.threads);
  const archivedCount = useManagerThreadsStore((s) => s.archived.length);
  const dots = useThreadDots();
  // Duty threads are not listed here: the On duty page lists them, and those
  // the owner put in the sidebar have their own group above (OnDutyNavSection).
  const sorted = useMemo(
    () => sortThreadsForSidebar([...threads.values()].filter((t) => !t.duty), (id) => dots.get(id) ?? "idle"),
    [threads, dots]
  );
  // A thread that changes its place slides there; asked for less motion, it
  // moves at once.
  const slides = useRef<HTMLDivElement>(null);
  useSlideOnReorder(slides);
  // Every manager thread there is: the open ones (those on duty too) and the archived.
  const total = threads.size + archivedCount;
  if (total === 0) return null;
  return (
    <div className="flex flex-col">
      <div aria-hidden className="flex h-7 shrink-0 items-center px-2 pt-3 select-none">
        <span className="label-group">Threads</span>
      </div>
      {sorted.length > 0 && <div ref={slides} role="group" aria-label="Threads" className="relative flex flex-col gap-0.5">
        {sorted.map((t) => <ThreadNavRow key={t.id} thread={t} dot={dots.get(t.id) ?? "idle"} onNavigate={onNavigate} />)}
      </div>}
      {/* The sidebar keeps the open threads; every thread, archived ones
          too, is on the Threads page. */}
      <NavLink
        to="/threads"
        end
        data-slot="all-threads"
        onClick={() => onNavigate?.()}
        className="mt-1 flex h-7 min-w-0 shrink-0 items-center gap-2.5 rounded-sm px-2 text-xs text-faint transition-colors hover:bg-sel hover:text-muted-foreground pointer-coarse:h-9 [&.active]:bg-sel [&.active]:text-foreground"
      >
        {/* The state mark's slot: the words line up with the titles above. */}
        <span aria-hidden className="size-2.5 shrink-0" />
        <span data-slot="all-threads-label" className="min-w-0 truncate">All threads</span>
        <span data-slot="all-threads-count" className="ml-auto shrink-0 text-2xs tabular-nums">{total}</span>
      </NavLink>
    </div>
  );
}

/** An open thread's row: its link, and its ⋯ menu beside it. With a mouse
 *  the menu shows over the link's end on hover or focus, the title giving it
 *  room; on a touch screen it is always there. `end` is what the row says at
 *  its end (a duty thread's next check). */
export function ThreadNavRow({ thread: t, dot, end, onNavigate }: {
  thread: ManagerThreadDto;
  dot: ThreadDot;
  end?: ReactNode;
  onNavigate?: () => void;
}) {
  const unread = isThreadNew(t);
  return (
    <div data-slide-key={t.id} className="group/row relative flex min-w-0 shrink-0 items-center">
      <NavLink
        to={threadHref(t.id)}
        data-thread-title={t.title}
        data-unread={unread || undefined}
        onClick={() => onNavigate?.()}
        className={cn(
          "flex h-7 pointer-coarse:h-9 min-w-0 flex-1 items-center gap-2.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors group-hover/row:bg-sel group-hover/row:text-foreground [&.active]:bg-sel [&.active]:text-foreground",
          "pointer-fine:group-hover/row:pr-7 pointer-fine:group-focus-within/row:pr-7 pointer-fine:group-has-[[data-state=open]]/row:pr-7"
        )}
      >
        <ThreadStateMark dot={dot} />
        {/* Unread is the bright, bold title: a word beside it took the
            title's room and said it again. A screen reader still hears it. */}
        <span className={cn("min-w-0 truncate", unread && "font-semibold text-foreground")}>{t.title}</span>
        {unread && <span className="sr-only">New</span>}
        {end}
      </NavLink>
      <ThreadMenu threadId={t.id} row={{ title: t.title }} onLeave={onNavigate} />
    </div>
  );
}
