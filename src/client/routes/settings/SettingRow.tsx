import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One setting: name and description on the left, control on the right.
 *
 * This replaces the label-above-control-above-hint stack the panes used to
 * build by hand. That stack cost three lines per setting and buried the name —
 * the thing you actually scan for — under the same weight as its hint. Read as
 * a column, rows give a pane a legible list of names with the controls in a
 * single right-hand gutter.
 *
 * `fit` decides that gutter's width. Fields (inputs, selects) share one width
 * so they line up down the group; switches and button clusters hug the right
 * edge instead, because stretching them to a field's width would imply an
 * affordance they don't have.
 */
export function SettingRow({
  label,
  description,
  hint,
  anchor,
  fit = "field",
  stacked,
  children
}: {
  label: ReactNode;
  description?: ReactNode;
  /** Fine print below the control — consequences, not restatement of the label. */
  hint?: ReactNode;
  /** Search target: the shell scrolls to and flashes `#setting-<anchor>`. */
  anchor?: string;
  fit?: "field" | "wide" | "auto";
  /** Controls that need the full width (textarea, editable lists) go below. */
  stacked?: boolean;
  children?: ReactNode;
}) {
  const control = children ? (
    <div
      className={cn(
        "min-w-0",
        stacked ? "mt-2.5" : "sm:justify-self-end",
        // 288px: wide enough for a base URL without truncating, which 224px
        // was not, and still leaves the label column the larger share at every
        // pane width. `wide` is for fully-qualified model refs — the longest
        // values anywhere in settings. Both are right-aligned, so a group
        // mixing them still has one straight right edge.
        !stacked && fit === "field" && "w-full sm:w-72",
        !stacked && fit === "wide" && "w-full sm:w-80"
      )}
    >
      {children}
    </div>
  ) : null;

  return (
    <div
      id={anchor ? `setting-${anchor}` : undefined}
      data-setting-anchor={anchor}
      className="scroll-mt-4 px-4 py-3"
    >
      <div
        className={cn(
          !stacked && "sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-8"
        )}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium leading-snug">{label}</div>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-chrome">{description}</p>
          ) : null}
        </div>
        {control}
      </div>
      {hint ? <p className="mt-2 text-xs leading-relaxed text-chrome">{hint}</p> : null}
    </div>
  );
}

/**
 * A labelled sub-region inside a group — the fallback list, a provider's model
 * table. It is not a setting itself, so it carries no name/control geometry;
 * it only needs a quiet caption and room for its own rows.
 */
export function SettingSubGroup({
  label,
  action,
  children
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="label-micro text-chrome">{label}</span>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
