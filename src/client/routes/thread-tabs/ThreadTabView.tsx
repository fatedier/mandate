import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight } from "lucide-react";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { formatCalendarDate } from "@/lib/format";
import { threadHref } from "@/lib/worker-href";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { archivedReadOnlyNote } from "@/routes/threads/archived-note";
import { useMarkThreadSeen, useThreadReadPoint } from "@/routes/threads/useMarkThreadSeen";
import { useThreadTitle } from "./panel-thread-tabs";

/**
 * A thread open beside the personal agent: a bar with its name and the way to its
 * page, over its whole conversation, as its page has it (a composer to write
 * to its manager, read-only once archived). A worker opened from it opens on
 * the thread's page, which has the workers' panel. Seen while `inSight`, as
 * the thread's page marks itself. A thread in neither list (the archived one
 * not read yet, or its read failed) is not known to be open: no conversation,
 * and so no composer, until it is.
 */
export function ThreadTabView({ threadId, inSight }: { threadId: string; inSight: boolean }) {
  const title = useThreadTitle(threadId);
  const open = useManagerThreadsStore((s) => s.threads.has(threadId));
  const archivedAt = useManagerThreadsStore((s) => (open ? null : s.archived.find((t) => t.id === threadId)?.archivedAt ?? null));
  const readFailed = useManagerThreadsStore((s) => s.archivedReadFailed);
  const loadArchived = useManagerThreadsStore((s) => s.loadArchived);
  const navigate = useNavigate();
  const scope = useMemo(() => ({ type: "manager" as const, threadId }), [threadId]);
  const readPoint = useThreadReadPoint(threadId, inSight);
  useMarkThreadSeen(threadId, inSight);
  const openWorker = useCallback((workerId: string) => {
    void navigate(`${threadHref(threadId)}?worker=${encodeURIComponent(workerId)}`);
  }, [navigate, threadId]);
  return (
    <div data-slot="thread-tab-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft pl-3 pr-2 pointer-coarse:gap-3">
        <span data-slot="thread-tab-title" className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</span>
        {archivedAt && <span className="shrink-0 text-2xs text-faint">Archived {formatCalendarDate(archivedAt)}</span>}
        <div className="min-w-0 flex-1" />
        <Link
          to={threadHref(threadId)}
          className="hit relative inline-flex shrink-0 items-center gap-0.5 rounded-xs text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          Open thread
          <ChevronRight className="size-3" aria-hidden />
        </Link>
      </div>
      {open || archivedAt ? (
        <ChatConversation
          scope={scope}
          onOpenWorker={openWorker}
          readOnlyNote={archivedAt ? archivedReadOnlyNote(archivedAt) : undefined}
          newSince={readPoint}
        />
      ) : readFailed ? (
        <div className="px-4 pt-6"><InlineError onRetry={() => void loadArchived()}>Couldn't load the thread.</InlineError></div>
      ) : (
        <div className="px-4 pt-6"><LoadingLine /></div>
      )}
    </div>
  );
}
