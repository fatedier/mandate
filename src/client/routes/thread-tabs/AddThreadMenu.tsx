import { useMemo } from "react";
import { TerminalMenuItems } from "@/routes/terminals/TerminalMenuItems";
import { CalendarDays, Check, Plus, SquareCheckBig, StickyNote } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { CALENDAR_TAB, NOTES_TAB, TASKS_TAB } from "@/lib/panel-tabs";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useTasksNeedingYou } from "@/routes/task-board/tasks-panel-tab";
import { useUnseenNotes } from "@/routes/sticky-notes/unseen-notes";
import { useThreadDots } from "@/hooks/useThreadDots";
import { sortThreadsForSidebar } from "@/lib/thread-dot";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadTabs } from "@/store/thread-tabs";
import { openThreadBeside } from "./open-thread-beside";
import { ThreadTabMark } from "./ThreadTabMark";

/** "+" after the personal agent's tabs (`name`: the agent's, as its page says
 *  it): the owner's Tasks first, then the open threads in the sidebar's
 *  order, each with its mark and a tick when it is open beside the agent
 *  already; one chosen opens beside it (an open one shows). */
export function AddThreadMenu({ name }: { name: string }) {
  const tasksOpen = useAgentPageUi((s) => s.tabs.includes(TASKS_TAB));
  const needYou = useTasksNeedingYou();
  const notesOpen = useAgentPageUi((s) => s.tabs.includes(NOTES_TAB));
  const unseenNotes = useUnseenNotes();
  const calendarOpen = useAgentPageUi((s) => s.tabs.includes(CALENDAR_TAB));
  const threads = useManagerThreadsStore((s) => s.threads);
  const dots = useThreadDots();
  const open = useThreadTabs();
  const sorted = useMemo(() => sortThreadsForSidebar([...threads.values()], (id) => dots.get(id) ?? "idle"), [threads, dots]);
  const label = `Open a thread beside ${name}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 44px wide on a touch screen, so its touch area stays clear of the
            last tab's Close. */}
        <button
          type="button"
          aria-label={label}
          title={label}
          className="hit relative flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-chrome hover:bg-sel hover:text-foreground pointer-coarse:w-11"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuItem data-slot="add-tasks-tab" onSelect={() => useAgentPageUi.getState().openTasks()}>
          <SquareCheckBig aria-hidden className="size-3.5 text-chrome" />
          <span className="min-w-0 flex-1 truncate">Tasks</span>
          {needYou > 0 && <span title="Tasks that need you" className="inline-flex"><AttentionBadge count={needYou} urgent /></span>}
          {tasksOpen && <Check role="img" aria-label="Open" className="size-3.5 text-faint" />}
        </DropdownMenuItem>
        <DropdownMenuItem data-slot="add-notes-tab" onSelect={() => useAgentPageUi.getState().openNotes()}>
          <StickyNote aria-hidden className="size-3.5 text-chrome" />
          <span className="min-w-0 flex-1 truncate">Notes</span>
          <AttentionBadge count={unseenNotes} urgent={false} />
          {notesOpen && <Check role="img" aria-label="Open" className="size-3.5 text-faint" />}
        </DropdownMenuItem>
        <DropdownMenuItem data-slot="add-calendar-tab" onSelect={() => useAgentPageUi.getState().openCalendar()}>
          <CalendarDays aria-hidden className="size-3.5 text-chrome" />
          <span className="min-w-0 flex-1 truncate">Calendar</span>
          {calendarOpen && <Check role="img" aria-label="Open" className="size-3.5 text-faint" />}
        </DropdownMenuItem>
        <TerminalMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs font-medium text-faint">Open beside {name}</DropdownMenuLabel>
        {sorted.length === 0 && <DropdownMenuItem disabled>No open threads</DropdownMenuItem>}
        {sorted.map((thread) => (
          <DropdownMenuItem key={thread.id} onSelect={() => { void openThreadBeside(thread.id); }}>
            <ThreadTabMark threadId={thread.id} />
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            {open.some((tab) => tab.threadId === thread.id) && <Check role="img" aria-label="Open" className="size-3.5 text-faint" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
