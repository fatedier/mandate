import type { ComponentPropsWithRef, MouseEvent } from "react";
import { Link } from "react-router";
import type { NavItem } from "@/shell/nav-config";
import { cn } from "@/lib/utils";

// Nav is orientation furniture: it rests at muted contrast and comes forward
// on hover or when active. Selection is a --sel fill, never the primary — the
// primary is reserved for the send button and focus rings.
export const collapsedLinkClass =
  "relative flex size-9 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-sel [&.active]:text-foreground [&.active]:bg-sel";

/** An expanded row. New thread is one too (NewThreadRow.tsx): same shape,
 *  type and colour as the rows under it. 36px on a touch screen, like the
 *  thread rows, not the 44px of touch rows elsewhere: the navigation is a long
 *  list on a small screen. */
export const expandedLinkClass =
  "relative flex h-[30px] w-full pointer-coarse:h-9 items-center gap-2.5 rounded-sm px-2 text-xs font-[450] text-muted-foreground transition-colors hover:text-foreground hover:bg-sel [&.active]:text-foreground [&.active]:bg-sel";

type NavItemRowProps = Omit<ComponentPropsWithRef<typeof Link>, "to" | "target"> & {
  item: NavItem;
  active: boolean;
  /** Resolved destination (section-memory aware), not necessarily item.to. */
  target: string;
  /** Icon-only 36px square row (desktop sidebar collapsed mode). */
  collapsed?: boolean;
  /** Fires on row navigation; the mobile sheet closes itself with it. */
  onNavigate?: () => void;
};

/** Shared nav row for the desktop sidebar and mobile nav sheet: link
 *  classes, icon + label.
 *  Unknown props (including ref) spread onto the Link so Radix `asChild`
 *  wrappers (the sidebar's collapsed Tooltip) keep working. */
export function NavItemRow({
  item,
  active,
  target,
  collapsed,
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
      </Link>
    </div>
  );
}
