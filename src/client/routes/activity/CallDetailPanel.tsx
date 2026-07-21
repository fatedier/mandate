import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { errorMessageText, unwrapErrorReason } from "@shared/error-reason";
import { formatCallDurationMs } from "./activity-model";
import { buildCallDetailFields } from "./call-detail-fields";
import { formatExactTokens, tokenBreakdown, type TokenGroup } from "./format";
import type { ActivityCallDetail, ActivityCallDetailResponse } from "./types";

/**
 * One call's whole record, in a panel that slides in from the right.
 *
 * It replaces an in-row expansion that animated `grid-template-rows` from 0fr
 * to 1fr. That grew the row, which pushed every row below it down the page —
 * including whatever the reader had opened the row to compare it against. A
 * panel takes its space from the side, so the list it was opened from does not
 * move at all.
 */
interface CallDetailPanelProps {
  callId: string | null;
  onClose: () => void;
}

export function CallDetailPanel({ callId, onClose }: CallDetailPanelProps) {
  const [detail, setDetail] = useState<ActivityCallDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    const controller = new AbortController();
    // Deferred a tick so the state writes below land outside the effect body.
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      setDetail(null);
      void fetch(api.activityCall(callId), { signal: controller.signal })
        .then(async (res) => {
          const payload = await readJson<Exclude<ActivityCallDetailResponse, { error: string }>>(res);
          if (!cancelled) setDetail(payload.call);
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError") return;
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [callId]);

  const fields = useMemo(() => (detail ? buildCallDetailFields(detail) : []), [detail]);
  const tokens = useMemo(() => (detail ? tokenBreakdown(detail) : []), [detail]);
  const sections = useMemo(
    () =>
      detail
        ? (
            [
              ["metadata", detail.metadata],
              ["request", detail.request],
              ["response", detail.response],
              ["output", detail.output],
              ["usage", detail.usage],
              ["error", detail.error]
            ] as const
          ).filter(([, value]) => hasContent(value))
        : [],
    [detail]
  );
  // The same unwrapper the breakdown table's reason line reads through, not the
  // generic client one: wrapped provider failures record their message as
  // "Type validation failed: Value: {…}" with the provider's own sentence
  // nested inside, and `extractErrorMessage` answers with the wrapper's first
  // line. Two surfaces naming the same failure two different ways is worse
  // than either name on its own.
  const reason = detail?.error ? unwrapErrorReason(errorMessageText(detail.error)) : "";

  return (
    <Sheet
      open={callId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        data-call-detail
        className="w-full gap-0 p-0 sm:max-w-[44rem]"
        aria-describedby={undefined}
      >
        <header className="flex flex-col gap-1 border-b border-border-soft px-5 py-4 pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="truncate text-sm leading-tight">
              {detail?.purpose ?? "LLM call"}
            </SheetTitle>
            {detail?.status && <StatusBadge status={detail.status} />}
            {detail?.latencyMs != null && (
              <span className="num text-2xs text-chrome">
                {formatCallDurationMs(detail.latencyMs)}
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {detail?.id ?? callId ?? ""}
          </p>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto scrollbar-thin px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : detail ? (
            <>
              {/* Above the payloads, because the reason a call is being opened
                  is usually that it failed, and the unwrapped message is two
                  hundred lines of Zod output away inside `error`. */}
              {reason && (
                <div
                  data-call-error
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
                >
                  <div className="label-micro text-destructive/80">Error</div>
                  <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs text-destructive/90">
                    {reason}
                  </div>
                </div>
              )}
              {(fields.length > 0 || tokens.length > 0) && (
                <div
                  data-call-fields
                  // Container queries, not `sm:`/`lg:`. The panel is a fixed
                  // 44rem, so viewport breakpoints made the same panel three
                  // narrow columns on a wide screen and two roomy ones on a
                  // small screen — the column count tracking the window behind
                  // it rather than its own width.
                  className="@container grid gap-x-6 gap-y-3 rounded-lg border border-border-soft bg-card/50 px-4 py-3 @min-[26rem]:grid-cols-2 @min-[40rem]:grid-cols-3"
                >
                  {fields.map((field) => (
                    <Field key={field.label} label={field.label} value={field.value} />
                  ))}
                  <TokenBlock groups={tokens} />
                </div>
              )}
              {sections.map(([label, value]) => (
                <JsonSection key={label} label={label} value={value} />
              ))}
              {sections.length === 0 && fields.length === 0 && tokens.length === 0 && (
                <div className="rounded-md border border-dashed border-border-soft px-3 py-6 text-center text-sm text-muted-foreground">
                  No payload data.
                </div>
              )}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="label-micro text-chrome">{label}</div>
      <div className="truncate font-mono text-xs text-foreground/85" title={value}>
        {value}
      </div>
    </div>
  );
}

/**
 * The token counts, as the two containments they are: cached is part of input,
 * reasoning is part of output.
 *
 * It spans the grid rather than taking a cell, because as one cell it was four
 * figures in a third of the panel and truncated on 95% of calls — the reader
 * lost cache and reasoning entirely, which are the two the other two are
 * measured against.
 */
export function TokenBlock({ groups }: { groups: TokenGroup[] }) {
  return (
    <div className="col-span-full min-w-0 space-y-1">
      <div className="label-micro text-chrome">tokens</div>
      {groups.length === 0 ? (
        <div className="font-mono text-xs text-foreground/85">—</div>
      ) : (
        <div className="grid gap-x-8 gap-y-1 @min-[26rem]:grid-cols-2">
          {groups.map((group) => (
            <div key={group.label} className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="label-micro text-chrome">{group.label}</span>
                <span className="num text-xs font-semibold text-foreground">
                  {formatExactTokens(group.value)}
                </span>
              </div>
              {group.part && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="label-micro text-faint">{group.part.label}</span>
                  <span className="num text-2xs text-muted-foreground">
                    {formatExactTokens(group.part.value)}
                    {group.part.share !== null && (
                      <span className="ml-2 text-faint">{group.part.share}%</span>
                    )}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const COLLAPSE_LINE_THRESHOLD = 40;

function JsonSection({ label, value }: { label: string; value: unknown }) {
  const isError = label === "error";
  const formatted = formatJson(value);
  const sizeLabel = describeSize(value, formatted);
  const lineCount = formatted.split("\n").length;
  const shouldCollapse = lineCount > COLLAPSE_LINE_THRESHOLD;
  const [copied, setCopied] = useState(false);

  const handleCopy = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const ok = await copyTextToClipboard(formatted);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border bg-card/50",
        isError ? "border-destructive/40" : "border-border-soft"
      )}
    >
      <details open={!shouldCollapse}>
        <summary
          className={cn(
            "group flex cursor-pointer select-none items-center justify-between gap-2 px-4 py-2 outline-none [&::-webkit-details-marker]:hidden",
            isError ? "bg-destructive/5" : "bg-muted/30",
            "hover:bg-muted/45"
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90",
                !shouldCollapse && "invisible"
              )}
            />
            <span
              className={cn(
                "label-micro",
                isError ? "text-destructive" : "text-foreground/70"
              )}
            >
              {label}
            </span>
            {sizeLabel && (
              <span className="num font-mono text-2xs text-muted-foreground">{sizeLabel}</span>
            )}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy JSON"}
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              copied && "text-phase-done"
            )}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="sr-only">{copied ? "Copied" : "Copy JSON"}</span>
          </button>
        </summary>
        {/* Never wraps: a wrapped payload reflows every time the panel is
            resized, and the line a reader was on moves. */}
        <pre className="overflow-x-auto scrollbar-thin px-4 py-3 text-xs leading-relaxed">
          <code>{highlightJson(formatted)}</code>
        </pre>
      </details>
    </section>
  );
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function describeSize(value: unknown, formatted: string): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).length;
    return `${keys} key${keys === 1 ? "" : "s"}`;
  }
  const bytes = new Blob([formatted]).size;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Light-touch JSON syntax highlighting. Operates on JSON.stringify output so
 *  the token shapes are predictable. Distinguishes object keys, strings,
 *  numbers, booleans, and null with muted accent colors that read in both
 *  light and dark themes. */
function highlightJson(text: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [whole, str, colon, num, bool, nul] = match;
    if (str) {
      if (colon) {
        out.push(
          <span key={key++} className="text-phase-working">
            {str}
          </span>
        );
        out.push(colon);
      } else {
        out.push(
          <span key={key++} className="text-phase-done">
            {str}
          </span>
        );
      }
    } else if (num) {
      out.push(
        <span key={key++} className="text-phase-design">
          {num}
        </span>
      );
    } else if (bool) {
      out.push(
        <span key={key++} className="text-status-review">
          {bool}
        </span>
      );
    } else if (nul) {
      out.push(
        <span key={key++} className="text-muted-foreground">
          {nul}
        </span>
      );
    } else {
      out.push(whole);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded" ? "ok" : status === "running" || status === "pending" ? "info" : "error";
  return (
    <span
      className={cn(
        "label-micro inline-flex items-center rounded-md border px-1.5 py-0.5",
        tone === "ok"
          ? "border-phase-done/25 bg-phase-done/12 text-phase-done"
          : tone === "info"
            ? "border-phase-working/25 bg-phase-working/12 text-phase-working"
            : "border-destructive/25 bg-destructive/12 text-destructive"
      )}
    >
      {status}
    </span>
  );
}
