import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { useThreadDots } from "@/hooks/useThreadDots";

/** A thread's state as the sidebar marks it, in a tab's or a menu item's
 *  14px icon slot. An archived thread is not among the dots: idle, no mark. */
export function ThreadTabMark({ threadId }: { threadId: string }) {
  const dot = useThreadDots().get(threadId) ?? "idle";
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <ThreadStateMark dot={dot} />
    </span>
  );
}
