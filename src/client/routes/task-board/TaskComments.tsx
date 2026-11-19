import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Link2, Link2Off, PencilLine } from "lucide-react";
import { MarkdownView } from "@/components/MarkdownView";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTaskBoardStore } from "@/store/task-board";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { errorText } from "@shared/error-text";
import { TASK_STATUS_LABEL } from "@shared/task-board";
import { mentionLabel, type Mention } from "@shared/mentions";
import type { TaskEntryDto, TaskStatus } from "@shared/api/task-board";
import { TaskStatusIcon } from "./TaskStatusIcon";

/** A change line's words; a kind this page does not know shows its own text. */
function lineText(entry: TaskEntryDto, who: string): string {
  switch (entry.kind) {
    case "status":
      return entry.status === "cancelled" ? `${who} cancelled it` : `${who} moved it to ${entry.status ? TASK_STATUS_LABEL[entry.status] : "?"}`;
    case "link":
      return `${who} linked ${entry.threadTitle ?? "a thread"}${entry.newThread ? " (a new thread)" : ""}`;
    case "unlink":
      return `${who} unlinked ${entry.threadTitle ?? "a thread"}`;
    case "result":
      return entry.text === "updated" ? `${who} updated the result` : `${who} wrote the result`;
    default:
      return entry.text || String(entry.kind);
  }
}

function LineIcon({ entry }: { entry: TaskEntryDto }) {
  if (entry.kind === "status" && entry.status) return <TaskStatusIcon status={entry.status} className="size-3" />;
  const Icon = entry.kind === "link" ? Link2 : entry.kind === "unlink" ? Link2Off : entry.kind === "result" ? PencilLine : null;
  return Icon ? <Icon aria-hidden className="size-3" /> : null;
}

function Avatar({ name, agent }: { name: string; agent: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
        agent ? "bg-status-review text-background" : "bg-muted-foreground text-background"
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The task's stream: comments, the owner's and the agent's, and between them
 * grey lines for status changes, links and the Result, newest first, so a
 * task opens on its latest. The box above them comments; @<agent> in it has
 * the agent act now, without it the agent reads it the next time it works
 * on the task.
 */
export function TaskComments({ taskId, entries, agentName, now, ask = 0 }: {
  taskId: string;
  entries: readonly TaskEntryDto[] | null;
  agentName: string;
  now: number;
  /** Counts each "Ask <name>": the box starts with @<name>. */
  ask?: number;
}) {
  const comment = useTaskBoardStore((s) => s.comment);
  const send = useCallback(async (text: string, _attachments?: unknown, mentions?: Mention[]) => {
    try {
      await comment(taskId, { text, mentions: mentions ?? [] });
      if (!(mentions ?? []).some((m) => m.kind === "agent")) toast.message(`Comment added. ${agentName} reads it the next time it works on this task.`);
    } catch (err) {
      toast.error(errorText(err));
      throw err;
    }
  }, [comment, taskId, agentName]);
  const mentions = useMemo(() => ({ excludeId: null, agent: true }), []);
  const prefill = useMemo(() => (ask > 0 ? { key: ask, mention: { kind: "agent", id: "personal", label: mentionLabel(agentName) } } : undefined), [ask, agentName]);
  const count = entries?.filter((e) => e.kind === "comment").length ?? 0;
  const newestFirst = useMemo(() => (entries ? [...entries].reverse() : null), [entries]);
  return (
    <section data-slot="task-comments" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        Comments <span className="font-normal tabular-nums text-faint">{count}</span>
      </h3>
      <ChatInput
        layout="inline"
        images={false}
        prefill={prefill}
        draftKey={`task-comment:${taskId}`}
        onSend={send}
        mentions={mentions}
        placeholder={`Leave a comment. @${agentName} to have ${agentName} act on it now.`}
        sendLabel="Comment"
      />
      {newestFirst && (
        <div data-slot="task-stream" className="flex flex-col">
          {newestFirst.length === 0 && <p className="text-xs text-faint">No comments yet.</p>}
          {newestFirst.map((entry) => {
            const who = entry.by === "owner" ? "You" : agentName;
            const age = formatRelativeTime(entry.createdAt, now);
            if (entry.kind !== "comment") {
              return (
                <div key={entry.id} data-slot="task-line" className="flex items-center gap-2 py-1.5 pl-1 text-xs text-faint">
                  <span className="inline-flex w-3.5 justify-center"><LineIcon entry={entry} /></span>
                  <span className="min-w-0 flex-1">{lineText(entry, who)}</span>
                  <span className="shrink-0 whitespace-nowrap pl-2 tabular-nums">{age}</span>
                </div>
              );
            }
            return (
              <div key={entry.id} data-slot="task-comment" className="flex gap-2.5 py-2">
                <Avatar name={who} agent={entry.by === "agent"} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div data-slot="task-comment-head" className="flex min-w-0 items-center gap-2 text-[13px]">
                    <span className="font-semibold text-foreground">{who}</span>
                    {entry.status && <MovedTo status={entry.status} />}
                    <span className="ml-auto shrink-0 whitespace-nowrap pl-2 text-xs tabular-nums text-faint">{age}</span>
                  </div>
                  <MarkdownView text={entry.text} dense breaks />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MovedTo({ status }: { status: TaskStatus }) {
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <TaskStatusIcon status={status} className="size-3" />moved it to {TASK_STATUS_LABEL[status]}
    </span>
  );
}
