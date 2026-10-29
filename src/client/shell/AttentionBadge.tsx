import { cn } from "@/lib/utils";

/** Count pill for what waits on the user — the one colour the nav spends,
 *  and it is status, not selection: red when a thread broke, yellow when a
 *  question waits, the review colour when only decisions and results to read
 *  wait. Shared by the desktop sidebar and the
 *  mobile nav sheet so the markup and a11y stay in sync.
 *
 *  `floating` sits it on an icon (the phone's menu button, the collapsed
 *  sidebar's pen): there it is a dot, not digits — an 18px pill over a 20px
 *  glyph covered it. The number stays in the name, and on the row the menu
 *  opens to. */
export function AttentionBadge({ count, urgent, failed = false, floating }: { count: number; urgent: boolean; failed?: boolean; floating?: boolean }) {
  if (count <= 0) return null;
  // A label on a plain span is not read: as an image, it is read whole
  // ("2 items need you"), not as a bare number. It names what the colour
  // says, so the two colours are not one announcement.
  const name = urgent
    ? `${count} ${count === 1 ? "item needs" : "items need"} you`
    : `${count} ${count === 1 ? "item" : "items"} to look at`;
  if (floating) {
    return (
      <span
        role="img"
        aria-label={name}
        title={name}
        className={cn("absolute top-1.5 right-1.5 size-2 rounded-full", failed ? "bg-red" : urgent ? "bg-status-input" : "bg-status-review")}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full px-1.5 text-2xs font-semibold num",
        failed
          ? "bg-[color-mix(in_oklab,var(--red)_var(--pill-mix),transparent)] text-red"
          : urgent
            ? "bg-[color-mix(in_oklab,var(--status-input)_var(--pill-mix),transparent)] text-status-input-fg"
            : "bg-[color-mix(in_oklab,var(--status-review)_var(--pill-mix),transparent)] text-status-review"
      )}
      role="img"
      aria-label={name}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
