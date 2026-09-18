import { ChevronDown, ChevronUp } from "lucide-react";

/** One quiet row standing in for a run of system rows. */
export function FoldedSystemRun({ summary, expanded, onToggle }: {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <div data-slot="system-fold" className="flex h-6 items-center gap-2 px-1 text-2xs text-faint">
      <span className="min-w-0 truncate">{summary}</span>
      <span aria-hidden className="h-px flex-1 bg-border-soft" />
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex shrink-0 items-center gap-1 transition-colors hover:text-foreground"
      >
        {expanded ? "Hide" : "Show"}
        <Chevron className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
