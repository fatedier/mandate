import type { ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SectionFooterState } from "./settings-config";

/**
 * The save-unit shell: one bordered group with a header, a body, and a footer
 * that only exists while its SectionFooterState has something to say.
 * Read-only sections omit `footer` and never grow one.
 *
 * `rows` switches the body to hairline-divided SettingRows and is how nearly
 * every pane renders now. A group of rows costs one border for N settings; the
 * card-per-setting it replaced spent a full border, radius, and 16px gap on
 * single toggles, so the chrome outweighed what it framed.
 *
 * With `collapse`, the header row becomes a toggle button (rotating caret) and
 * the body only renders while open; the footer keeps its own visibility rules
 * so dirty/error/saved signals survive collapsing.
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
  /** A group with nothing to show renders header-only rather than an empty
   *  bordered strip — an off override switch needs no body. */
  children?: ReactNode;
}) {
  const showFooter =
    footer !== undefined && (footer.dirty || footer.saving || !!footer.error || footer.justSaved);

  const headerContent = (
    <>
      {collapse ? (
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-chrome transition-transform duration-200",
            collapse.open && "rotate-90"
          )}
        />
      ) : null}
      {collapse ? (
        // A heading element is not valid inside a button; keep the same look.
        <span className="text-sm font-semibold">{title}</span>
      ) : (
        <h3 className="text-sm font-semibold">{title}</h3>
      )}
      {titleMeta}
      {restartPill ? (
        <span className="rounded-full border border-status-review/35 px-2 text-2xs font-semibold text-status-review">
          restart on change
        </span>
      ) : null}
      {headerSlot !== undefined ? <div className="ml-auto">{headerSlot}</div> : null}
    </>
  );

  const open = !collapse || collapse.open;

  return (
    <section
      id={anchor ? `setting-${anchor}` : undefined}
      className={cn(
        "scroll-mt-4 overflow-hidden rounded-xl border border-border-soft bg-card transition-colors",
        footer?.dirty && "border-primary/45"
      )}
    >
      {collapse ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
          aria-expanded={collapse.open}
          onClick={collapse.onToggle}
        >
          {headerContent}
        </button>
      ) : (
        <div className={cn("px-4 pt-3", description ? "pb-3" : "pb-2.5")}>
          <div className="flex min-h-7 items-center gap-2">{headerContent}</div>
          {description ? (
            <span className="mt-0.5 block max-w-prose text-xs leading-relaxed text-chrome">
              {description}
            </span>
          ) : null}
        </div>
      )}
      {open && children ? (
        rows ? (
          <div className="divide-y divide-border-soft border-t border-border-soft">{children}</div>
        ) : (
          // The header already supplies the gap below itself, so the body only
          // pads its bottom.
          <div className="flex flex-col gap-3 px-4 pb-3.5">{children}</div>
        )
      ) : null}
      {showFooter ? (
        <div className="flex items-center gap-3 border-t border-border-soft bg-panel px-4 py-2">
          {footer.error ? (
            <span className="text-xs text-destructive">{footer.error}</span>
          ) : footer.dirty ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              {/* Styled dot rather than a ● glyph: the character's size and
                  baseline are font-dependent, so it can't be optically centred
                  against the label. Matches the StatusDot idiom. */}
              <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              Unsaved changes
            </span>
          ) : null}
          <div className="flex-1" />
          {footer.justSaved ? (
            <span className="inline-flex items-center gap-1 text-xs text-live">
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Saved
            </span>
          ) : null}
          <Button size="sm" disabled={footer.saving || footer.disabled} onClick={footer.onSave}>
            {footer.saving ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
