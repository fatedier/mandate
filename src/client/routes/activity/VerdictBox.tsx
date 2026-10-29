import type { CacheVerdictDto } from "@shared/api-contracts";
import { cn } from "@/lib/utils";
import { VERDICT_LABELS, verdictSentence } from "./ledger-copy";

/** Why this call paid for its prompt again: amber for an expired cache (money
 *  lost to a pause), neutral for the rest. */
export function VerdictBox({ verdict, model }: { verdict: CacheVerdictDto; model: string | null }) {
  const expired = verdict.kind === "expired";
  return (
    <div
      data-call-verdict={verdict.kind}
      className={cn("rounded-lg border px-4 py-2.5", expired ? "border-amber/30 bg-amber/5" : "border-border-soft bg-panel")}
    >
      <div className={cn("label-micro", expired ? "text-amber" : "text-chrome")}>{VERDICT_LABELS[verdict.kind]}</div>
      <div className="mt-0.5 text-xs leading-relaxed text-foreground/85">{verdictSentence(verdict, model)}</div>
    </div>
  );
}
