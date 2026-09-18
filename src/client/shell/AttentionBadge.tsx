import { cn } from "@/lib/utils";

/** Amber count pill for work items flagged needsUser — the one colour the nav
 *  spends, and it is status, not selection. Shared by the desktop sidebar and
 *  the mobile nav sheet so the markup and a11y stay in sync. */
export function AttentionBadge({ count, floating }: { count: number; floating?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full px-1.5 text-2xs font-semibold num",
        "bg-[color-mix(in_oklab,var(--status-review)_var(--pill-mix),transparent)] text-status-review",
        floating && "absolute -top-0.5 -right-0.5"
      )}
      aria-label={`${count} ${count === 1 ? "item needs" : "items need"} you`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
