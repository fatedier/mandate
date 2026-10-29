import type { AgentContextUsage } from "@/store/agent-chat";
import { cn } from "@/lib/utils";
import { positiveNumberOrNull } from "@shared/positive-number";

/** How full the conversation's context is, measured on the last successful
 *  agent call. Hosts put it in their header; a worker's is a line of its menu
 *  (`inMenu`), above the action that answers it. Nothing until a call has
 *  measured it: a "--" would be a standing control that says nothing. */
export function ContextBudgetPill({ usage, compact = false, inMenu = false }: { usage: AgentContextUsage | null; compact?: boolean; inMenu?: boolean }) {
  const inputTokens = positiveNumberOrNull(usage?.inputTokens);
  const budgetTokens = positiveNumberOrNull(usage?.budgetTokens);
  if (inputTokens === null || budgetTokens === null) return null;
  const percent = Math.max(0, Math.round((inputTokens / budgetTokens) * 100));
  const fillPercent = Math.min(percent, 100);
  // Nearing the budget it warns: yellow, then red where the next call will
  // likely compact it. The number takes the colour with its meter, which
  // alone is too small to catch the eye. Neither the violet of "ready for
  // review" nor the red of "needs you": a compaction asks nothing of the user.
  const level = percent >= 95 ? "full" : percent >= 85 ? "near" : "room";
  const fillTone = { room: "bg-faint", near: "bg-meter-warn", full: "bg-red" }[level];
  const textTone = { room: "text-faint", near: "text-meter-warn-fg", full: "text-red" }[level];
  const title = `Last successful agent call used ${formatTokenCount(inputTokens)} of ${formatTokenCount(budgetTokens)} compression budget.`;

  // On desktop this degrades with the dock's own width (container queries on
  // the header); see the `compact` note on the className for why a phone
  // cannot use that rule.
  // Thresholds are sized against the WORST-CASE tab row (Manager + a
  // max-width feature tab + badges + buttons ≈ 27rem): the pill must be the
  // first thing to go — an informational pill never gets to truncate the
  // scope tabs, which are primary controls. Full pill ≥31rem, bare
  // percentage ≥27rem, hidden below.
  return (
    <div
      data-slot={inMenu ? "context-line" : undefined}
      className={cn(
        "shrink-0 items-center gap-1.5 text-2xs", textTone,
        // A menu's line: whole whatever the width (no header's width rules
        // reach a menu), with a menu item's padding so the meter starts where
        // the items' icons do.
        inMenu ? "px-2 py-1.5" : "px-1.5",
        // Two rules on purpose. The desktop dock can be dragged to any width,
        // so it degrades by width. A phone has exactly one width — the header's
        // content box measures 358px at 390px, which can never reach 27rem — so
        // a width rule there is always false and would hide the pill forever.
        // The feature chat was the one mobile state without room for the pill;
        // collapsing its two scope tabs into one switch control bought that
        // state the ~40px it was missing, so the phone's rule is now simply
        // `isMobile`. One rule covering both would have to lie to one of them.
        // A phone's pill carries its meter under the number, as wide as it:
        // a bare "15%" said nothing, and beside the number the meter would
        // take 30px from the title (at 360px that left a few characters of it).
        compact ? "flex flex-col-reverse items-stretch gap-[3px]" : inMenu ? "flex" : "hidden @[27rem]:flex"
      )}
      title={title}
      aria-label={title}
    >
      <span className={cn(
        "overflow-hidden rounded-full bg-sel",
        compact ? "block h-[3px] w-full" : inMenu ? "block h-1 w-9" : "hidden h-1 w-9 @[31rem]:block"
      )}>
        <span
          // It grows to the figure (and turns colour) gently.
          className={cn("block h-full rounded-full transition-[width,background-color] duration-300 ease-(--ease-ui) motion-reduce:transition-none", fillTone)}
          style={{ width: `${fillPercent}%` }}
        />
      </span>
      <span className="whitespace-nowrap">
        <span className={inMenu ? undefined : "hidden @[31rem]:inline"}>Context </span>
        {percent}%
      </span>
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}
