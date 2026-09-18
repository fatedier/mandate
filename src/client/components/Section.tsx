import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";

/** The redesign's section: a 32px header line (title · meta · spacer ·
 *  trailing) and ONE quiet panel under it. The header line is the eyebrow;
 *  nothing inside the panel repeats it.
 *
 *  `subheader` is a second line between the header and the panel, for a
 *  control that fits the trailing slot wide but not narrow; the caller gates
 *  each copy with `@max-[34rem]:` so only one is ever displayed. */
export function Section({
  title, meta, trailing, subheader, panel = true, className, children, "aria-label": ariaLabel
}: {
  title: ReactNode; meta?: ReactNode; trailing?: ReactNode; subheader?: ReactNode; panel?: boolean;
  className?: string; children: ReactNode; "aria-label"?: string;
}) {
  return (
    // `@container`: the narrow rules inside a section (`@max-[34rem]:`) are
    // measured against the section itself, so a 600px pane on a wide screen
    // reads as wide and a phone reads as narrow. `min-w-0`: a grid or flex
    // item defaults to min-width:auto, which lets a long meta line push the
    // section wider than its column.
    <section aria-label={ariaLabel} className={cn("@container flex min-w-0 flex-col gap-1.5", className)}>
      <div data-slot="section-header" className="flex h-8 items-center gap-2">
        <span data-slot="section-title" className="whitespace-nowrap text-xs font-semibold text-foreground">{title}</span>
        {/* `false` and "" count as absent so `meta={n > 0 && …}` never mounts an empty span; 0 still renders.
            Narrow, the meta goes: the title and the trailing control keep the 32px line. */}
        {meta != null && meta !== false && meta !== "" && (
          <span data-slot="section-meta" className="num min-w-0 truncate text-2xs text-faint @max-[34rem]:hidden">{meta}</span>
        )}
        <span className="flex-1" />
        {trailing}
      </div>
      {subheader}
      {panel ? (
        <div data-slot="section-panel" className="overflow-hidden rounded-lg border border-border-soft bg-panel">{children}</div>
      ) : children}
    </section>
  );
}

/** A section-level navigation link: muted text with a chevron, never blue. */
export function SectionLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn("flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground", className)}>
      {children}
      <ChevronRight className="size-3" aria-hidden />
    </Link>
  );
}

const ROW_MIN_H = { "40": "min-h-10", "44": "min-h-11", "52": "min-h-13" } as const;

/** One hairline-separated row inside a section panel. */
export function SectionRow({ className, children, minH = "40" }: { className?: string; children: ReactNode; minH?: keyof typeof ROW_MIN_H }) {
  return (
    <div data-slot="section-row" className={cn("flex items-center gap-3 border-t border-border-soft px-3.5 py-1.5 first:border-t-0", ROW_MIN_H[minH], className)}>
      {children}
    </div>
  );
}
