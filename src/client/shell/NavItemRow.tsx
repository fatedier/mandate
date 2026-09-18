import type { ComponentPropsWithRef, MouseEvent } from "react";
import { Link } from "react-router";
import type { NavItem } from "@/shell/nav-config";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { cn } from "@/lib/utils";

// Nav is orientation furniture: it rests at muted contrast and comes forward
// on hover or when active. Selection is a --sel fill, never the primary — the
// primary is reserved for the send button and focus rings.
const collapsedLinkClass =
  "relative flex size-9 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-sel [&.active]:text-foreground [&.active]:bg-sel";

const expandedLinkClass =
  "relative flex h-[30px] w-full items-center gap-2.5 rounded-sm px-2 text-xs font-[450] text-muted-foreground transition-colors hover:text-foreground hover:bg-sel [&.active]:text-foreground [&.active]:bg-sel";

type NavItemRowProps = Omit<ComponentPropsWithRef<typeof Link>, "to" | "target"> & {
  item: NavItem;
  active: boolean;
  /** Resolved destination (section-memory aware), not necessarily item.to. */
  target: string;
  /** Icon-only 36px square row (desktop sidebar collapsed mode). */
  collapsed?: boolean;
  /** Attention count; pass only for the row that owns the badge (Home). */
  badgeCount?: number;
  /** Fires on row navigation; the mobile sheet closes itself with it. */
  onNavigate?: () => void;
};

/** Shared nav row for the desktop sidebar and mobile nav sheet: link
 *  classes, icon + label, attention badge.
 *  Unknown props (including ref) spread onto the Link so Radix `asChild`
 *  wrappers (the sidebar's collapsed Tooltip) keep working. */
export function NavItemRow({
  item,
  active,
  target,
  collapsed,
  badgeCount,
  onNavigate,
  className,
  onClick,
  ...linkProps
}: NavItemRowProps) {
  const Icon = item.icon;
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    onNavigate?.();
  };

  if (collapsed) {
    return (
      <Link
        to={target}
        className={cn(collapsedLinkClass, active && "active", "relative", className)}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        onClick={handleClick}
        {...linkProps}
      >
        <Icon className="size-4 shrink-0" />
        {badgeCount !== undefined && <AttentionBadge count={badgeCount} floating />}
      </Link>
    );
  }

  return (
    <div>
      <Link
        to={target}
        className={cn(expandedLinkClass, active && "active", className)}
        aria-current={active ? "page" : undefined}
        onClick={handleClick}
        {...linkProps}
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1">{item.label}</span>
        {badgeCount !== undefined && <AttentionBadge count={badgeCount} />}
      </Link>
    </div>
  );
}
