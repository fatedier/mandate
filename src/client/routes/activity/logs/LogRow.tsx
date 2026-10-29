import { errorMessageText, unwrapErrorReason } from "@shared/error-reason";
import { cn } from "@/lib/utils";
import { formatDateTimeTitle, formatRelativeTime } from "@/lib/format";
import {
  cacheHitRate,
  formatCallDurationMs,
  formatTokenCount,
  tokensPerSecond
} from "../activity-model";
import { durationMsForCall, providerNameForCall } from "../format";
import { costLabel } from "../money";
import { answerLabel, notUsedLine, rowVerdictLine, threadLine, VERDICT_LABELS } from "../ledger-copy";
import { judgementOf } from "../judgement";
import type { ActivityCall } from "../types";

interface LogRowProps {
  call: ActivityCall;
  /** Keep elapsed time and relative timestamps on the list's refresh clock. */
  nowMs: number;
  selected: boolean;
  onOpen: () => void;
}

export function LogRow({ call, nowMs, selected, onOpen }: LogRowProps) {
  const rate = tokensPerSecond(call.outputTokens, call.latencyMs);
  const cached = cacheHitRate(call.inputTokens, call.cacheReadTokens);
  const providerName = providerNameForCall(call);
  const providerTitle = providerName;
  const modelId = call.model || providerName;
  const model = modelId || "Unknown model";
  // A failed call has no tokens to read, so its row says why instead: the
  // reason the detail panel and the Breakdown show, out of the SDK's wrapper.
  const failed = call.status === "failed";
  const reason = failed && call.error ? unwrapErrorReason(errorMessageText(call.error)) : null;
  const amount = costLabel(call.cost);
  const verdict = call.ledger?.verdict ?? null;
  // A judgement's answer, as a chip; why it was not used, as a line.
  const judgement = judgementOf(call.metadata);

  return (
    <li className="border-b border-border-soft last:border-b-0">
      <button
        type="button"
        data-log-row
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(
          "flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-sel",
          selected && "bg-sel"
        )}
      >
        <span data-log-info className="flex min-w-0 flex-1 flex-col gap-1 @max-[36rem]:basis-full">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* As the Breakdown table sets a model id: mono at 13px. "Unknown
                model" is words, in the body face. */}
            <span
              data-log-model
              className={cn("max-w-full truncate font-medium text-foreground", modelId ? "font-mono text-xs" : "text-sm")}
              title={model}
            >
              {model}
            </span>
            <span
              data-log-purpose
              className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
              title={call.purpose}
            >
              {call.purpose}
            </span>
            {verdict && (
              <span data-log-verdict-chip className={cn("pill shrink-0", verdict.kind === "expired" ? "pill-amber" : "pill-neutral")}>
                {VERDICT_LABELS[verdict.kind]}
              </span>
            )}
            {judgement && (
              <span data-log-answer className="pill pill-neutral shrink-0">{answerLabel(judgement.answer)}</span>
            )}
            {call.status === "succeeded" ? null : <StatusWord status={call.status} />}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-chrome">
            <time dateTime={call.createdAt} title={formatDateTimeTitle(call.createdAt) || undefined}>
              {formatRelativeTime(call.createdAt, nowMs)}
            </time>
            {providerName && (
              <>
                <span aria-hidden="true">·</span>
                <span data-log-provider className="max-w-full truncate" title={providerTitle}>
                  {providerName}
                </span>
              </>
            )}
            {call.ledger && (
              <>
                <span aria-hidden="true">·</span>
                <span data-log-thread className="max-w-full truncate">{threadLine(call.ledger)}</span>
              </>
            )}
          </span>
          {verdict && (
            <span data-log-verdict className="truncate text-xs text-chrome">
              {rowVerdictLine(verdict, call.ledger?.wakeKey ?? null)}
            </span>
          )}
          {judgement?.notUsed && (
            <span data-log-not-used className="truncate text-xs text-chrome">{notUsedLine(judgement.notUsed)}</span>
          )}
          {reason && (
            <span data-log-reason className="truncate text-xs text-muted-foreground" title={reason}>
              {reason}
            </span>
          )}
        </span>
        {/* Query the card width so an open assistant dock gets the same layout
            as any other narrow space. Metrics wrap; model identity stays visible. */}
        <span
          data-log-metrics
          className="num flex max-w-full shrink-0 flex-col items-end gap-1 @max-[36rem]:w-full @max-[36rem]:flex-row @max-[36rem]:flex-wrap @max-[36rem]:items-center @max-[36rem]:justify-between @max-[36rem]:gap-x-3"
        >
          {amount && (
            <span data-log-cost className="whitespace-nowrap text-xs text-foreground" title="Cost">
              {amount}
            </span>
          )}
          {!failed && (
            <span
              data-log-tokens
              className="text-xs text-muted-foreground"
              title="Input → output tokens"
            >
              {formatTokenCount(call.inputTokens)} → {formatTokenCount(call.outputTokens)} tokens
            </span>
          )}
          <span className="flex flex-wrap items-center gap-x-2 text-2xs text-chrome">
            <span data-log-duration className="text-foreground" title="Latency">
              {formatCallDurationMs(durationMsForCall(call, nowMs))}
            </span>
            {!failed && (
              <>
                <span data-log-rate>{rate === null ? "—" : rate.toFixed(1)} tok/s</span>
                <span data-log-cache>{cached === null ? "—" : `${Math.round(cached)}%`} cache</span>
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function StatusWord({ status }: { status: string }) {
  return (
    <span
      data-log-status
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-2xs",
        status === "running" || status === "pending"
          ? "bg-phase-working/10 text-phase-working"
          : "bg-destructive/10 text-destructive"
      )}
    >
      {status}
    </span>
  );
}
