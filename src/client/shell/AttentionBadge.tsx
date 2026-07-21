import { cn } from "@/lib/utils";

/** Red count pill for work items flagged needsUser. Shared by the desktop
 *  sidebar and the mobile nav sheet so the markup and a11y stay in sync. */
export function AttentionBadge({ count, floating }: { count: number; floating?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-[16px] h-4 items-center justify-center rounded-full border border-status-input/25 bg-status-input/12 px-1 text-2xs font-semibold num text-status-input",
        floating && "absolute -top-0.5 -right-0.5"
      )}
      aria-label={`${count} ${count === 1 ? "item needs" : "items need"} you`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
