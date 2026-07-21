import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import {
  cacheHitRate,
  formatCallDurationMs,
  formatTokenCount,
  tokensPerSecond
} from "../activity-model";
import { durationMsForCall, providerNameForCall } from "../format";
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
  const providerTitle = call.matchedProviderName
    ? `${providerName} (matched to current configuration)`
    : providerName;
  const model = call.model || providerName || "Unknown model";

  return (
    <li className="border-b border-border-soft last:border-b-0">
      <button
        type="button"
        data-log-row
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(
          "flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-muted/40",
          selected && "bg-muted/60"
        )}
      >
        <span data-log-info className="flex min-w-0 flex-1 flex-col gap-1 @max-[36rem]:basis-full">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              data-log-model
              className="max-w-full truncate text-sm font-medium text-foreground"
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
            {call.status === "succeeded" ? null : <StatusWord status={call.status} />}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-chrome">
            <time dateTime={call.createdAt} title={call.createdAt}>
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
          </span>
        </span>
        {/* Query the card width so an open assistant dock gets the same layout
            as any other narrow space. Metrics wrap; model identity stays visible. */}
        <span
          data-log-metrics
          className="num flex max-w-full shrink-0 flex-col items-end gap-1 @max-[36rem]:w-full @max-[36rem]:flex-row @max-[36rem]:flex-wrap @max-[36rem]:items-center @max-[36rem]:justify-between @max-[36rem]:gap-x-3"
        >
          <span
            data-log-tokens
            className="text-xs text-muted-foreground"
            title="Input → output tokens"
          >
            {formatTokenCount(call.inputTokens)} → {formatTokenCount(call.outputTokens)} tokens
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-2xs text-chrome">
            <span data-log-duration className="text-foreground" title="Latency">
              {formatCallDurationMs(durationMsForCall(call, nowMs))}
            </span>
            <span data-log-rate>{rate === null ? "—" : rate.toFixed(1)} tok/s</span>
            <span data-log-cache>{cached === null ? "—" : `${Math.round(cached)}%`} cache</span>
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
