import { useMemo } from "react";
import { ArrowRight, ChevronRight, PanelRight } from "lucide-react";
import { Link } from "react-router";
import { MarkdownView } from "@/components/MarkdownView";
import { ReplyPeek } from "@/components/ReplyPeek";
import { Button } from "@/components/ui/button";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { markdownToText } from "@/lib/markdown-text";
import { cn } from "@/lib/utils";
import type { PersonalHandoffDto } from "@shared/api/personal-agent";
import { useHandoffHref } from "./handoff-tools";
import { useThreadTabs } from "@/store/thread-tabs";
import { openThreadBeside } from "@/routes/thread-tabs/open-thread-beside";
import { TaskChip } from "@/routes/task-board/TaskChip";

/** A label only for what is unusual, with why after it: that it simply
 *  went, or came back, is said by the notice line where it arrived. */
function stateOf(h: PersonalHandoffDto): { label: string; tone: string; why: string | null } | null {
  switch (h.state) {
    case "queued": return { label: "Queued", tone: "amber", why: h.kind === "worker" ? "worker busy" : "manager busy" };
    // A target gone before anything came back has only this line to say why.
    case "failed": return { label: "Failed", tone: "red", why: h.reason && h.repliedAt === null ? h.reason : null };
    default: return null;
  }
}

/** Where it went, after its name: a worker's thread, or a thread made for it. */
function placeOf(h: PersonalHandoffDto): string | null {
  if (h.kind === "worker") return h.ownerThreadTitle ? `in ${h.ownerThreadTitle}` : null;
  return h.newThreadTitle !== null ? "new thread" : null;
}

// On a touch screen the name is 44px to touch, by its own box: its text
// truncates inside it, so the box clips nothing of itself.
const TARGET_CLASS = "flex min-w-0 items-center rounded-xs font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11 pointer-coarse:min-w-11";

/** One thing the personal agent sent, as one line: where it went, its
 *  first line, and a label only when it waits or failed. The target's name
 *  opens the whole message with the ways there, a box at the name (on a
 *  phone, the sheet), so nothing in the transcript moves. Live from the
 *  store, the tool's result until the store has it. What came back is not
 *  drawn here: the notice that woke the agent is a line of its own where it
 *  arrived. */
export function HandoffCard({ handoffId, fallback, taskId }: { handoffId: string; fallback: PersonalHandoffDto | null; taskId?: string }) {
  const live = usePersonalAgentStore((s) => s.handoffs.get(handoffId) ?? null);
  const h = live ?? fallback;
  const href = useHandoffHref(h);
  const plain = useMemo(() => (h ? markdownToText(h.text) : ""), [h]);
  if (!h) return null;
  const target = h.kind === "worker" ? h.workerName ?? "a worker" : h.threadTitle ?? h.newThreadTitle ?? "a new thread";
  const place = placeOf(h);
  const first = plain.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
  const state = stateOf(h);
  const panelThread = href !== null && h.kind === "thread" ? h.threadId : null;

  const name = first !== null || href !== null ? (
    <ReplyPeek
      slot="handoff-peek"
      title={target}
      body={<div data-slot="handoff-peek-body">{h.text.trim() ? <MarkdownView text={h.text} dense /> : null}</div>}
      action={href === null ? undefined : (close) => (
        <>
          {panelThread ? <OpenThreadInPanel threadId={panelThread} onOpened={close} /> : null}
          <Button asChild variant="outline" size="xs" className="shrink-0">
            <Link to={href} data-slot="handoff-open" onClick={close}>
              {h.kind === "worker" ? "Open worker" : "Open thread"}
              <ChevronRight aria-hidden />
            </Link>
          </Button>
        </>
      )}
      trigger={(props) => (
        <button type="button" data-slot="handoff-target" className={TARGET_CLASS} {...props}>
          <span className="truncate">{target}</span>
        </button>
      )}
    />
  ) : <b className="min-w-0 truncate font-semibold text-foreground">{target}</b>;

  // One line that never wraps. The first line takes only the room left and
  // gives way first (on a narrow transcript it is not drawn); then where it
  // went; the name and why it waits or failed truncate last.
  return (
    <div
      data-slot="handoff-card"
      className="flex min-h-7 min-w-0 max-w-full items-center gap-1 whitespace-nowrap text-xs text-muted-foreground pointer-coarse:min-h-11"
    >
      <ArrowRight className="mr-0.5 size-3.5 shrink-0 text-status-review" aria-hidden />
      <span className="shrink-0">Sent to</span>{" "}
      {name}
      {place ? <>{" "}<span data-slot="handoff-place" className="min-w-0 shrink-[4] truncate text-faint">· {place}</span></> : null}
      {taskId ? <>{" "}<TaskChip id={taskId} className="min-w-0 shrink-[2]" /></> : null}
      {first ? <>{" "}<span data-slot="handoff-first" className="ml-1 min-w-0 flex-1 basis-0 truncate text-faint @max-[34rem]:hidden">{first}</span></> : null}
      {state ? (
        <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-1">
          {" "}<span data-slot="handoff-state" className={cn("pill shrink-0", `pill-${state.tone}`)}>{state.label}</span>
          {state.why ? <>{" "}<span data-slot="handoff-reason" className="min-w-0 truncate text-faint">{state.why}</span></> : null}
        </span>
      ) : null}
    </div>
  );
}

/** In a thread's box, before Open thread: the thread as a tab of the
 *  personal agent's panel, kept on the server so every device shows it. Once
 *  the thread is open there, a click only shows that tab. Either way the box
 *  closes: the page stays, with the panel beside it. */
function OpenThreadInPanel({ threadId, onOpened }: { threadId: string; onOpened: () => void }) {
  const open = useThreadTabs().some((tab) => tab.threadId === threadId);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-slot="handoff-panel"
      className="shrink-0"
      onClick={() => { onOpened(); void openThreadBeside(threadId); }}
    >
      <PanelRight aria-hidden />
      {open ? "Show in panel" : "Open in panel"}
    </Button>
  );
}
