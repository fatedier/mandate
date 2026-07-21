import { memo, Fragment, useState } from "react";
import { ChevronRight, ChevronDown, Loader2, Wrench, CircleAlert, CircleCheck } from "lucide-react";
import { formatDateTimeTitle, formatDuration, formatDurationAttribute } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/CopyButton";
import { argEntries, summarizeArgs } from "./tool-args-summary";
import { canvasReferenceFromResult, isCanvasReferenceTool } from "./canvas-reference";
import type { ToolImageResultContent } from "@shared/agent-message-types";

export interface ToolCallSpec {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultSpec {
  result?: unknown;
  isError?: boolean;
  error?: string;
  createdAt?: string;
}

interface ToolCallCardProps {
  call: ToolCallSpec;
  result: ToolResultSpec | null;
  isRunning: boolean;
  startedAt?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

/** Below this, the duration is noise: it is dominated by the gap between when
 *  the step finished and when its result row was written, and 94% of calls land
 *  in the same displayed second as the message above them anyway. Showing a
 *  number for those buys nothing and costs the row's remaining width. */
const SLOW_TOOL_DURATION_MS = 1000;

/** The only claim this row is allowed to make about time.
 *
 *  There is no per-tool start on the wire — a tool message's `createdAt` is
 *  when it FINISHED. `startedAt` is therefore derived by the caller from the
 *  preceding completed event, and every way that derivation can be wrong has to
 *  end in `null` here rather than in a plausible-looking number: still running
 *  (no end yet), no result (never came back), an unparseable timestamp on
 *  either side, or an end before the start (which means the order we walked was
 *  not the order things ran). Guessing was the bug this replaces — a second
 *  tool that really took 450ms was reading 7.8s because it was measured from
 *  the assistant message instead of from the tool before it. */
function toolElapsed(
  isRunning: boolean,
  startedAt: string | undefined,
  completedAt: string | undefined
): { ms: number; label: string } | null {
  if (isRunning || !startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < SLOW_TOOL_DURATION_MS) return null;
  return { ms, label: formatDuration(ms) };
}

function formatPayload(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isToolImageResultContent(value: unknown): value is ToolImageResultContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "view_image_result" || typeof record.message !== "string") return false;
  const image = record.image;
  if (!image || typeof image !== "object" || Array.isArray(image)) return false;
  const img = image as Record<string, unknown>;
  return img.type === "image" &&
    typeof img.displayPath === "string" &&
    typeof img.mediaType === "string" &&
    typeof img.data === "string" &&
    typeof img.sizeBytes === "number";
}

function imageResultSrc(result: ToolImageResultContent): string {
  return `data:${result.image.mediaType};base64,${result.image.data}`;
}

function formatByteSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "unknown size";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function ToolCallCardImpl({ call, result, isRunning, startedAt, expanded: controlledExpanded, onExpandedChange }: ToolCallCardProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const setExpanded = (next: boolean) => {
    if (controlledExpanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const status = isRunning
    ? "running"
    : result?.isError ? "error"
    : result ? "ok"
    : "pending";
  const argsText = formatPayload(call.args);
  const argRows = argEntries(call.args);
  // The title lives in the call's own result, so it is the name the canvas had
  // when this ran — a store lookup would show whatever it is called today.
  const canvasTitle =
    !result?.isError && isCanvasReferenceTool(call.toolName)
      ? canvasReferenceFromResult(result?.result)?.title ?? null
      : null;
  const imageResult = !result?.isError && isToolImageResultContent(result?.result) ? result.result : null;
  const resultText = result?.isError
    ? (result.error ?? "(no error message)")
    : imageResult
      ? `${imageResult.message}\n${imageResult.image.mediaType}, ${formatByteSize(imageResult.image.sizeBytes)}`
      : formatPayload(result?.result);
  const hasLongResult = resultText.length > 800;
  // The header used to repeat the assistant message's clock as this call's
  // start time — the same second, three or nineteen times over, for a start it
  // did not actually know. How long the call took is the thing the clock was
  // standing in for, so show that instead, and only when it is both true and
  // worth the width.
  const elapsed = toolElapsed(isRunning, startedAt, result?.createdAt);
  const completedAtTitle = result?.createdAt ? formatDateTimeTitle(result.createdAt) : "";

  const StatusIcon =
    status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> :
    status === "error"   ? <CircleAlert className="h-3.5 w-3.5 text-red" /> :
    status === "ok"      ? <CircleCheck className="h-3.5 w-3.5 text-green" /> :
                            <Wrench className="h-3.5 w-3.5 text-muted-foreground" />;

  return (
    <div className={cn(
      "border border-border-soft rounded-md my-1 bg-card/50 text-xs"
    )}>
      {/* Every class outside a variant below is the wide row exactly as it has
          always been, and the narrow layout is added under `@max-[34rem]:`
          (`@container (width < 34rem)`). Written this way round on purpose: the
          first attempt made narrow the default and had wide undo it, which made
          "wide is unaffected" a property that had to be re-measured rather than
          one that holds by construction — and it silently broke twice, once by
          reordering the row and once by refusing to shrink a long tool name
          until the trailing metadata was pushed out of the card. Nothing here
          may gain an unprefixed class or a min-width `@[34rem]:` variant; a
          test pins that. */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-2 py-1.5 hover:bg-muted/30 rounded-t-md text-left @max-[34rem]:flex-wrap @max-[34rem]:gap-y-0.5"
      >
        <Chevron className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {StatusIcon}
        {/* Narrow only: `flex-1` gives the name a zero basis so flex line-breaking
            stops reserving its full max-content width and pushing the trailing
            metadata onto a line of its own; `truncate` can then do the yielding
            instead. Wide keeps no truncate at all, which is what lets a long
            name wrap inside its own span rather than shove the metadata out of
            the card. */}
        <span
          data-slot="tool-name"
          className="font-mono font-semibold @max-[34rem]:flex-1 @max-[34rem]:min-w-0 @max-[34rem]:truncate"
        >
          {call.toolName}
        </span>
        {/* Narrow only: `order-2` sorts this after the duration, and `w-full`
            with an auto basis (`flex-none`) makes it claim a line of its own;
            `pl-11` (14px chevron + 8 + 14px icon + 8) lines it up under the
            tool name. DOM order is unchanged from the wide row, so the duration
            needs no ordering class of its own — and because the duration is now
            optional, this row also has to look right with nothing after the
            name at all. */}
        <span
          data-slot="tool-args"
          className="text-muted-foreground truncate flex-1 @max-[34rem]:order-2 @max-[34rem]:w-full @max-[34rem]:flex-none @max-[34rem]:pl-11"
        >
          {summarizeArgs(call.args, canvasTitle)}
        </span>
        {elapsed && (
          <time
            data-slot="tool-duration"
            className="shrink-0 text-2xs tabular-nums text-muted-foreground"
            dateTime={formatDurationAttribute(elapsed.ms)}
            title={completedAtTitle ? `Completed ${completedAtTitle}` : undefined}
          >
            {elapsed.label}
          </time>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border-soft px-3 py-2 space-y-2">
          {/* Labelled rows rather than a re-print of the JSON already previewed
              in the header. Reading a value out of `{"command":"…","cwd":"…"}`
              means parsing syntax to find the payload; a key column does that
              for you. Complex shapes still fall back to formatted JSON. */}
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="label-micro text-chrome">args</span>
              <span aria-hidden className="h-px flex-1 bg-border-soft" />
              <CopyButton text={argsText} label="Copy args" />
            </div>
            {argRows ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-sm bg-terminal-bg p-2">
                {argRows.map(([key, value]) => (
                  <Fragment key={key}>
                    <dt className="font-mono text-2xs text-chrome">{key}</dt>
                    <dd className="scroll-x-quiet min-w-0 whitespace-pre font-mono text-2xs text-foreground">
                      {typeof value === "string" ? value : formatPayload(value)}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            ) : (
              <pre className="scroll-x-quiet max-w-full whitespace-pre rounded-sm bg-terminal-bg p-2 text-2xs text-foreground">
                {argsText}
              </pre>
            )}
          </div>
          {result && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="label-micro shrink-0 text-chrome">
                  {result.isError ? "error" : "result"}
                </span>
                <span aria-hidden className="h-px flex-1 bg-border-soft" />
                {hasLongResult && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="shrink-0 text-2xs text-chrome transition-colors hover:text-foreground"
                  >
                    {showAll ? "Collapse" : "Expand"}
                  </button>
                )}
                <CopyButton text={resultText} label="Copy result" />
              </div>
              {imageResult ? (
                <div className="rounded-sm bg-terminal-bg p-2 text-2xs text-foreground">
                  <a
                    href={imageResultSrc(imageResult)}
                    target="_blank"
                    rel="noreferrer"
                    className="mb-2 block w-fit overflow-hidden rounded-xs border border-border-soft bg-background/60"
                    title={imageResult.image.displayPath || imageResult.image.name}
                  >
                    <img
                      src={imageResultSrc(imageResult)}
                      alt={imageResult.image.displayPath || imageResult.image.name || "Viewed image"}
                      className="max-h-48 max-w-full object-contain"
                    />
                  </a>
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">{resultText}</div>
                </div>
              ) : (
                // The two axes are split across two elements on purpose. The
                // wrapper caps height and owns vertical scrolling, which keeps a
                // normal scrollbar; the inner pre owns horizontal overflow and
                // hides its bar. Putting both on one element meant
                // `scrollbar-width: none` suppressed the vertical bar too.
                //
                // `whitespace-pre`, not `pre-wrap`: `git diff --stat` draws a
                // column of bars and table-shaped output aligns by character, so
                // reflowing destroys the alignment that carries the meaning.
                <div className={cn(
                  "max-w-full rounded-sm text-2xs",
                  result.isError ? "bg-red/10 text-red" : "bg-terminal-bg text-foreground",
                  hasLongResult && !showAll && "max-h-[min(28rem,55vh)] overflow-y-auto scrollbar-thin"
                )}>
                  <pre className="scroll-x-quiet whitespace-pre p-2">
                    {resultText}
                  </pre>
                </div>
              )}
            </div>
          )}
          {isRunning && !result && (
            <div className="text-2xs text-muted-foreground italic">Running…</div>
          )}
        </div>
      )}
    </div>
  );
}

// Memoised: the transcript re-renders on every streaming delta, and an
// unmemoised row means all of them re-render for each token.
export const ToolCallCard = memo(ToolCallCardImpl);
