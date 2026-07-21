import type { ComponentPropsWithRef, MouseEvent } from "react";
import { Link } from "react-router";
import type { NavItem } from "@/shell/nav-config";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { cn } from "@/lib/utils";

// Nav is orientation furniture, so it rests at chrome contrast and only comes
// forward on hover or when active. The active row is marked by a left rail
// rather than a filled pill: a tinted block competes with the phase colours in
// the content, whereas a 2px rail reads as position without spending colour.
const collapsedLinkClass =
  "flex h-10 w-10 items-center justify-center rounded-lg text-foreground transition-colors hover:text-foreground hover:bg-foreground/5 [&.active]:text-primary [&.active]:bg-primary/10";

const expandedLinkClass =
  "relative flex h-10 w-full items-center gap-3 rounded-lg pl-3 pr-2 text-sm text-foreground transition-colors hover:text-foreground hover:bg-foreground/5 " +
  "[&.active]:text-foreground [&.active]:bg-foreground/[0.06] " +
  "[&.active]:before:absolute [&.active]:before:left-0 [&.active]:before:top-1/2 [&.active]:before:h-4 [&.active]:before:w-0.5 " +
  "[&.active]:before:-translate-y-1/2 [&.active]:before:rounded-full [&.active]:before:bg-primary";

type NavItemRowProps = Omit<ComponentPropsWithRef<typeof Link>, "to" | "target"> & {
  item: NavItem;
  active: boolean;
  /** Resolved destination (section-memory aware), not necessarily item.to. */
  target: string;
  /** Icon-only 40px square row (desktop sidebar collapsed mode). */
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
        <Icon className="h-5 w-5 shrink-0" />
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
        <Icon className="h-5 w-5 shrink-0" />
        <span className="flex-1">{item.label}</span>
        {badgeCount !== undefined && <AttentionBadge count={badgeCount} />}
      </Link>
    </div>
  );
}
