import type { ActivityLedgerDto } from "@shared/api-contracts";
import { Section } from "@/components/Section";
import { LEDGER_COPY, TOKEN_LABELS, writeReadLine } from "../ledger-copy";
import { formatUsd } from "../money";

/** Lightness steps of one hue, so the parts tell apart without colour alone. */
const PARTS = [
  { key: "cacheWriteMicros", label: TOKEN_LABELS.cacheWrite, swatch: "bg-primary-soft" },
  { key: "cacheReadMicros", label: TOKEN_LABELS.cacheRead, swatch: "bg-primary" },
  { key: "outputMicros", label: TOKEN_LABELS.output, swatch: "bg-primary/45" },
  { key: "uncachedInputMicros", label: TOKEN_LABELS.uncachedInput, swatch: "bg-faint" },
  { key: "reportedUnsplitMicros", label: LEDGER_COPY.reportedUnsplit, swatch: "bg-sel" }
] as const;

/** What the spend is made of, by kind of token. Hidden with no spend. */
export function TokensSection({ ledger, estimated }: { ledger: ActivityLedgerDto; estimated: boolean }) {
  const parts = PARTS.map((part) => ({ ...part, micros: ledger.tokens[part.key] }))
    .filter((part) => part.key !== "reportedUnsplitMicros" || part.micros > 0);
  const total = parts.reduce((sum, part) => sum + part.micros, 0);
  if (total <= 0) return null;

  return (
    <Section title={LEDGER_COPY.tokens}>
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
        <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
          {parts.map((part) => <span key={part.key} className={part.swatch} style={{ width: `${(part.micros / total) * 100}%` }} />)}
        </div>
        <div className="grid grid-cols-[0.625rem_minmax(0,1fr)_4.5rem_2.5rem] items-center gap-x-2.5 gap-y-2 text-xs">
          {parts.map((part) => [
            <span key={`${part.key}-s`} className={`size-2.5 rounded-[2px] ${part.swatch}`} aria-hidden />,
            <span key={`${part.key}-l`}>{part.label}</span>,
            <span key={`${part.key}-a`} className="num text-right">{formatUsd(part.micros, estimated)}</span>,
            <span key={`${part.key}-p`} className="num text-right text-faint">{Math.round((part.micros / total) * 100)}%</span>
          ])}
        </div>
        {ledger.claudeWriteReadRatio !== null && <p className="text-2xs text-faint">{writeReadLine(ledger.claudeWriteReadRatio)}</p>}
      </div>
    </Section>
  );
}
