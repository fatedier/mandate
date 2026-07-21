import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** Page title — optional. The global TopBar's breadcrumb is the canonical
   *  location indicator, so most pages omit this and only carry subtitle +
   *  trailing actions. Set when the page needs a status message ("Feature not
   *  found") or richer info than the breadcrumb conveys (window number, etc.).
   *  A string renders as a styled h1; a ReactNode renders as-is. */
  title?: ReactNode;
  /** Description shown below the title on desktop only — hidden on mobile to
   *  keep the header tight. */
  subtitle?: ReactNode;
  /** Action(s) on the right of the title row. Pages typically pass a button
   *  cluster on desktop and a ⋯ DropdownMenu on mobile. */
  trailing?: ReactNode;
  /** Optional second row, e.g. filter chips or tabs. Horizontally scrollable
   *  on mobile when overflowing. */
  toolbar?: ReactNode;
  /** Optional leading element (e.g. back button on a drilldown). The global
   *  TopBar handles primary nav/hamburger; this slot is for page-local
   *  affordances only. */
  leading?: ReactNode;
  className?: string;
}

/**
 * Page sub-header used inside each route. The global TopBar (in AppShell)
 * provides location + global actions; PageHeader provides per-page title,
 * subtitle, trailing actions, and an optional toolbar row. Non-sticky on
 * both viewports — TopBar is the sticky chrome.
 */
export function PageHeader({
  title,
  subtitle,
  trailing,
  toolbar,
  leading,
  className
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "relative bg-transparent",
        className
      )}
    >
      <div
        className={cn(
          // Mobile: stack title and trailing so neither squeezes the other —
          // trailing button clusters (Archive + actions on the window page) need
          // their own row at narrow widths or they'd push the title down to ~0px.
          "flex flex-col items-stretch gap-2 px-3 py-2",
          // items-start, not items-end: with a two-line title block the trailing
          // actions were bottom-aligned, which left their optical centre floating
          // between the title and the metadata row, attached to neither. Page
          // actions belong on the title's line — that is what they act on.
          "md:flex-row md:flex-wrap md:items-start md:justify-between md:gap-3 md:px-0 md:py-0"
        )}
      >
        {leading && <div className="flex items-center gap-1 shrink-0">{leading}</div>}
        <div className="min-w-0 flex-1 md:order-none">
          {typeof title === "string" ? (
            <h1 className="truncate text-lg font-semibold md:text-2xl">
              {title}
            </h1>
          ) : (
            title
          )}
          {subtitle && (
            <p
              className={cn(
                "text-sm text-muted-foreground",
                // When title is present, subtitle is supplementary — desktop-only to keep
                // the mobile header tight. When no title, subtitle anchors the row on
                // both viewports; on mobile it single-line truncates so it doesn't push
                // the trailing actions out of view.
                title ? "hidden md:block mt-1" : "truncate md:mt-1 md:whitespace-normal"
              )}
            >
              {subtitle}
            </p>
          )}
        </div>
        {trailing && (
          <div className="flex items-center gap-1.5 shrink-0">{trailing}</div>
        )}
      </div>
      {toolbar && (
        <div className="px-3 pb-2 -mb-px overflow-x-auto scrollbar-thin md:px-0 md:pb-0 md:overflow-visible">
          {toolbar}
        </div>
      )}
    </header>
  );
}
