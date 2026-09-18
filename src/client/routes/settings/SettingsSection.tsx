import type { ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SectionFooterState } from "./settings-config";

/**
 * The save-unit shell, on the list language every other page speaks: a 32px
 * header line (title · description as meta · restart pill · trailing slot)
 * over ONE bg-panel hairline panel that holds the body, and a footer row that
 * only exists while its SectionFooterState has something to say. Read-only
 * sections omit `footer` and never grow one. A dirty panel borrows the
 * attention frame — a frame means "wants you", and an unsaved group does.
 *
 * `rows` switches the body to hairline-divided SettingRows and is how nearly
 * every pane renders now. A group of rows costs one panel for N settings.
 *
 * With `collapse`, the header line becomes a toggle button (rotating caret)
 * and the panel only renders while open; the footer keeps its own visibility
 * rules so dirty/error/saved signals survive collapsing. A group with nothing
 * to show renders the header line alone — an off override switch needs no
 * panel.
 */
export function SettingsSection({
  title,
  titleMeta,
  description,
  headerSlot,
  restartPill,
  collapse,
  rows,
  anchor,
  footer,
  children
}: {
  title: string;
  titleMeta?: ReactNode; // inline adornment right after the title (e.g. a type chip)
  description?: string;
  headerSlot?: ReactNode; // e.g. a Switch on override sections
  restartPill?: boolean; // renders the "restart on change" pill
  collapse?: { open: boolean; onToggle: () => void }; // collapsible group header
  rows?: boolean; // body is divided SettingRows that pad themselves
  /** Search target for settings that live in the header (a group-level switch). */
  anchor?: string;
  footer?: SectionFooterState; // omit for read-only sections (no footer ever)
  children?: ReactNode;
}) {
  const showFooter =
    footer !== undefined && (footer.dirty || footer.saving || !!footer.error || footer.justSaved);
  const open = !collapse || collapse.open;
  const showPanel = (open && !!children) || showFooter;

  const headerParts = (
    <>
      {titleMeta}
      {description ? (
        <span data-slot="section-meta" className="min-w-0 truncate text-2xs text-faint" title={description}>
          {description}
        </span>
      ) : null}
      {restartPill ? (
        <span className="shrink-0 rounded-full border border-status-review/35 px-2 text-2xs font-semibold text-status-review">
          restart on change
        </span>
      ) : null}
      <span className="flex-1" />
      {headerSlot !== undefined ? <div className="flex shrink-0 items-center">{headerSlot}</div> : null}
    </>
  );

  // A collapsible group is a list item, not a section: its header is a 44px
  // row INSIDE the panel (the providers list reads as rows that open in
  // place), so the panel always exists and the caret row is what you click.
  const collapseRow = collapse ? (
    <div data-slot="section-header" className="flex min-h-11 items-center gap-2 px-3.5">
      {/* A heading element is not valid inside a button; keep the same look. */}
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-expanded={collapse.open}
        onClick={collapse.onToggle}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-chrome transition-transform duration-200",
            collapse.open && "rotate-90"
          )}
        />
        <span data-slot="section-title" className="text-xs font-semibold text-foreground">{title}</span>
      </button>
      {headerParts}
    </div>
  ) : null;

  return (
    <section
      id={anchor ? `setting-${anchor}` : undefined}
      data-slot="settings-section"
      className="scroll-mt-4 flex min-w-0 flex-col gap-1.5"
    >
      {!collapse ? (
        <div data-slot="section-header" className="flex h-8 items-center gap-2">
          <h3 data-slot="section-title" className="text-xs font-semibold text-foreground">{title}</h3>
          {headerParts}
        </div>
      ) : null}
      {collapse || showPanel ? (
        <div
          data-slot="section-panel"
          className={cn(
            "overflow-hidden rounded-lg border border-border-soft bg-panel transition-colors",
            footer?.dirty && "border-status-review/45"
          )}
        >
          {collapseRow}
          {open && children ? (
            rows ? (
              <div className={cn("divide-y divide-border-soft", collapse && "border-t border-border-soft")}>{children}</div>
            ) : (
              <div className={cn("flex flex-col gap-3 px-3.5 py-3", collapse && "border-t border-border-soft")}>{children}</div>
            )
          ) : null}
          {showFooter ? (
            <div
              className={cn(
                "flex min-h-10 items-center gap-3 px-3.5 py-1.5",
                open && children && "border-t border-border-soft"
              )}
            >
              {footer.error ? (
                <span className="text-xs text-destructive">{footer.error}</span>
              ) : footer.dirty ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  {/* Styled dot rather than a ● glyph: the character's size and
                      baseline are font-dependent, so it can't be optically centred
                      against the label. Matches the StatusDot idiom. */}
                  <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full bg-status-review" />
                  Unsaved changes
                </span>
              ) : null}
              <div className="flex-1" />
              {footer.justSaved ? (
                <span className="inline-flex items-center gap-1 text-xs text-live">
                  <Check className="size-3.5 shrink-0" aria-hidden />
                  Saved
                </span>
              ) : null}
              <Button size="xs" disabled={footer.saving || footer.disabled} onClick={footer.onSave}>
                {footer.saving ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
