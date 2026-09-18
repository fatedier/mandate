import { cn } from "@/lib/utils";

/** The unread count in the "needs you" tint — one spelling for the chat
 *  triggers, the scope tabs and the scope picker rows. Renders nothing for
 *  zero; placement (absolute corner, `ml-auto`) comes from `className`. */
export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-slot="unread-badge"
      className={cn(
        "num inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-status-review/20 px-1 text-2xs font-semibold text-status-review",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
