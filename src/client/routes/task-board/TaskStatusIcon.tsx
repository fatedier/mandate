import type { TaskStatus } from "@shared/api/task-board";
import { cn } from "@/lib/utils";

const TONE: Record<TaskStatus, string> = {
  backlog: "text-faint",
  todo: "text-faint",
  progress: "text-amber",
  review: "text-status-review",
  done: "text-phase-done",
  cancelled: "text-faint"
};

/** A status as a ring that fills as the work goes: dashed (Backlog), empty
 *  (Todo), half (In progress), three quarters (In review), a tick (Done), a
 *  cross (Cancelled). */
export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden data-slot="task-status-icon" data-status={status} className={cn("size-3.5 shrink-0", TONE[status], className)}>
      {status === "done" ? (
        <>
          <circle cx="8" cy="8" r="6.9" fill="currentColor" />
          <path d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" stroke="var(--color-background)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={status === "backlog" ? "2.2 2" : undefined} />
          {status === "progress" && <path d="M8 3.6a4.4 4.4 0 0 1 0 8.8z" fill="currentColor" />}
          {status === "review" && <path d="M8 3.6a4.4 4.4 0 1 1-4.4 4.4H8z" fill="currentColor" />}
          {status === "cancelled" && <path d="m6 6 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
        </>
      )}
    </svg>
  );
}
