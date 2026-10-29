import { useMemo, useRef, useState } from "react";
import { useSlideOnReorder } from "@/hooks/useSlideOnReorder";
import { Fold } from "@/components/Fold";
import { NavLink } from "react-router";
import { ChevronRight, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useUIStore } from "@/store/ui";
import { formatCalendarDate } from "@/lib/format";
import { DeleteArchivedThreadsDialog } from "@/routes/threads/DeleteThreadDialogs";
import type { ArchivedThreadDto } from "@shared/api/agents";
import { useThreadDots } from "@/hooks/useThreadDots";
import { isThreadNew, sortThreadsForSidebar } from "@/lib/thread-dot";
import { ThreadStateMark } from "./ThreadStateMark";
import { threadHref } from "@/lib/feature-href";
import { cn } from "@/lib/utils";


export function ThreadsNavSection({ onNavigate }: { onNavigate?: () => void }) {
  const threads = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  const dots = useThreadDots();
  const sorted = useMemo(
    () => sortThreadsForSidebar([...threads.values()], (id) => dots.get(id) ?? "idle"),
    [threads, dots]
  );
  // A thread that changes its place slides there; asked for less motion, it
  // moves at once.
  const slides = useRef<HTMLDivElement>(null);
  useSlideOnReorder(slides);
  if (sorted.length === 0 && archived.length === 0) return null;
  return (
    <div className="flex flex-col">
      <div aria-hidden className="flex h-7 shrink-0 items-center px-2 pt-3 select-none">
        <span className="label-group">Threads</span>
      </div>
      {sorted.length > 0 && <div ref={slides} role="group" aria-label="Threads" className="relative flex flex-col gap-0.5">
        {sorted.map((t) => {
          const dot = dots.get(t.id) ?? "idle";
          const unread = isThreadNew(t);
          return (
            <NavLink
              key={t.id}
              to={threadHref(t.id)}
              data-slide-key={t.id}
              data-thread-title={t.title}
              data-unread={unread || undefined}
              onClick={() => onNavigate?.()}
              className="flex h-7 pointer-coarse:h-9 min-w-0 shrink-0 items-center gap-2.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground [&.active]:bg-sel [&.active]:text-foreground"
            >
              <ThreadStateMark dot={dot} />
              {/* Unread is the bright, bold title: a word beside it took the
                  title's room and said it again. A screen reader still hears it. */}
              <span className={cn("min-w-0 truncate", unread && "font-semibold text-foreground")}>{t.title}</span>
              {unread && <span className="sr-only">New</span>}
            </NavLink>
          );
        })}
      </div>}
      {archived.length > 0 && <ArchivedThreads threads={archived} onNavigate={onNavigate} />}
    </div>
  );
}

/** The archived threads, under the open ones: a group closed by default,
 *  read-only rows, and a menu that deletes them all. */
function ArchivedThreads({ threads, onNavigate }: { threads: ArchivedThreadDto[]; onNavigate?: () => void }) {
  const open = useUIStore((s) => s.archivedThreadsOpen);
  const setOpen = useUIStore((s) => s.setArchivedThreadsOpen);
  const [deletingAll, setDeletingAll] = useState(false);
  return (
    <div className="mt-2 flex flex-col">
      <div className="group/archived flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 text-2xs text-faint transition-colors hover:bg-sel hover:text-muted-foreground pointer-coarse:h-11"
        >
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          <span>Archived</span>
          <span className="tabular-nums">{threads.length}</span>
        </button>
        {/* On a desktop on hover or focus; always on a touch screen, where
            it and the toggle are buttons of 44px (the rows are links: 36). */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Archived thread actions"
              className="shrink-0 text-faint opacity-0 group-hover/archived:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={() => setDeletingAll(true)}>
              <Trash2 className="h-4 w-4" />
              Delete all archived threads…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Fold open={open}>
        <div role="group" aria-label="Archived threads" className="flex flex-col gap-0.5">
          {threads.map((t) => (
            <NavLink
              key={t.id}
              to={threadHref(t.id)}
              onClick={() => onNavigate?.()}
              className="flex h-7 min-w-0 shrink-0 items-center gap-2.5 rounded-sm px-2 text-xs text-faint transition-colors hover:bg-sel hover:text-muted-foreground pointer-coarse:h-9 [&.active]:bg-sel [&.active]:text-foreground"
            >
              {/* The state mark's slot: the titles line up with the open ones. */}
              <span aria-hidden className="size-2.5 shrink-0" />
              <span className="min-w-0 truncate">{t.title}</span>
              <span className="ml-auto shrink-0 text-2xs tabular-nums">{formatCalendarDate(t.archivedAt)}</span>
            </NavLink>
          ))}
        </div>
      </Fold>
      {deletingAll && <DeleteArchivedThreadsDialog threads={threads} onDone={() => setDeletingAll(false)} />}
    </div>
  );
}
