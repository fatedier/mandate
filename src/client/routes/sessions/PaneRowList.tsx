import { ChevronRight, X } from "lucide-react";
import { Link } from "react-router";
import type { SessionWindowDto, WindowDetailDto } from "@shared/api-contracts";
import type { TypedSnapshot } from "@/lib/snapshot-types";
import { RelativeTime } from "@/components/RelativeTime";
import { cn } from "@/lib/utils";

export interface PaneRowData {
  paneId: string;
  index: number;
  /** The pane's metadata name, when an agent set one. */
  name: string | null;
  command: string;
  path: string;
  /** Output in the last five minutes, when the caller knows. */
  recentOutput: boolean;
  /** Dense rows only: a mono label before the name (the switcher's Recent
   *  group prints the window here). */
  prefix?: string;
  /** Dense rows only: when set, the row's trailing text is this time, relative. */
  at?: string;
}

export const RECENT_OUTPUT_MS = 5 * 60_000;

/** Pane `changedAt` by pane id for one session, read from the workspace
 *  snapshot. The snapshot only carries managed feature windows, so panes of
 *  unmanaged sessions are absent and read as quiet. */
export function paneChangedAtFromSnapshot(snapshot: TypedSnapshot | null, sessionName: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const s of snapshot?.sessions ?? []) {
    if (s.sessionName !== sessionName) continue;
    for (const w of s.windows ?? []) for (const p of w.panes ?? []) if (p.paneId) out[p.paneId] = p.changedAt;
  }
  return out;
}

export function shortenHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** `changedAtById` comes from the workspace snapshot where the caller has it
 *  (managed windows only); unknown panes read as quiet. */
export function paneRowsFromWindow(
  detail: WindowDetailDto,
  changedAtById: Record<string, string | undefined> = {},
  now: number = Date.now()
): PaneRowData[] {
  return detail.panes.map((p) => ({
    paneId: p.paneId,
    index: p.index,
    name: p.metadata?.name?.trim() || null,
    command: p.currentCommand,
    path: p.currentPath,
    recentOutput: isRecent(changedAtById[p.paneId], now)
  }));
}

export function paneRowsFromSessionWindow(
  w: SessionWindowDto,
  changedAtById: Record<string, string | undefined> = {},
  now: number = Date.now()
): PaneRowData[] {
  return w.panes.map((p) => ({
    paneId: p.paneId,
    index: p.index,
    name: p.metadata?.name?.trim() || null,
    command: p.currentCommand,
    path: p.currentPath,
    recentOutput: isRecent(changedAtById[p.paneId], now)
  }));
}

function isRecent(changedAt: string | undefined, now: number): boolean {
  if (!changedAt) return false;
  const t = Date.parse(changedAt);
  return Number.isFinite(t) && now - t <= RECENT_OUTPUT_MS;
}

interface Props {
  panes: PaneRowData[];
  hrefFor: (pane: PaneRowData) => string;
  currentPaneId?: string;
  /** 44px rows without the path line — the switcher sheet. Default rows are 56px with command · path. */
  dense?: boolean;
  onNavigate?: () => void;
  /** Dense rows only: renders a trailing × that calls back instead of
   *  navigating (the switcher's Recent group lets the user drop a row). */
  onDismiss?: (pane: PaneRowData) => void;
}

/** One pane per row: `[n]` · name (or the command, mono) · command · ~path ·
 *  activity dot · chevron. Used by the Window page on phones and by the
 *  terminal's pane switcher. A row is a link, so it is a real target for
 *  Tab and for screen readers; the activity dot is colour + aria-label. */
export function PaneRowList({ panes, hrefFor, currentPaneId, dense = false, onNavigate, onDismiss }: Props) {
  return (
    <ul data-slot="pane-rows" className={cn(!dense && "overflow-hidden rounded-lg border border-border-soft bg-panel")}>
      {panes.map((p) => {
        const current = p.paneId === currentPaneId;
        return (
          <li key={p.paneId} data-slot="pane-row" data-pane-id={p.paneId} data-current={current ? "true" : "false"}
              className={cn(!dense && "border-t border-border-soft first:border-t-0")}>
            <Link
              to={hrefFor(p)}
              aria-current={current ? "true" : undefined}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-2.5 pr-2 pl-3.5 transition-colors hover:bg-sel",
                dense ? "min-h-11 rounded-md py-1" : "min-h-14 py-2",
                current && "bg-sel"
              )}
            >
              <span data-slot="pane-index" className="num w-[22px] shrink-0 font-mono text-2xs text-faint">[{p.index}]</span>
              {dense && p.prefix && (
                <span data-slot="pane-prefix" className="flex shrink-0 items-center gap-1 font-mono text-2xs text-muted-foreground">
                  <span className="max-w-[7rem] truncate">{p.prefix}</span>
                  <span className="text-faint">/</span>
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span data-slot="pane-name" className={cn("block min-w-0 truncate text-xs font-medium text-foreground", !p.name && "font-mono")}>
                  {p.name ?? p.command}
                </span>
                {!dense && (
                  <span data-slot="pane-meta" className="mt-0.5 block truncate font-mono text-2xs text-muted-foreground">
                    {p.command} · {shortenHome(p.path)}
                  </span>
                )}
              </span>
              {dense && p.at && <span data-slot="pane-at" className="num shrink-0 text-2xs text-faint"><RelativeTime value={p.at} /></span>}
              {dense && !p.at && p.name && <span className="shrink-0 font-mono text-2xs text-faint">{p.command}</span>}
              <span
                data-slot="pane-dot"
                role="img"
                className={cn("size-1.5 shrink-0 rounded-full", p.recentOutput ? "bg-live" : "bg-faint")}
                aria-label={p.recentOutput ? "Recent output" : "Quiet"}
              />
              {dense && onDismiss && (
                // A button inside the row's link: stop the click so the row
                // does not navigate. 28px visual, 44px hit target via the inset.
                <button
                  type="button"
                  data-slot="pane-dismiss"
                  aria-label="Remove from Recent"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(p); }}
                  className="relative flex size-7 shrink-0 items-center justify-center rounded-sm text-faint transition-colors hover:bg-sel hover:text-foreground before:absolute before:-inset-2 before:content-['']"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
              {!dense && (
                <span className="flex size-9 shrink-0 items-center justify-center text-faint" aria-hidden>
                  <ChevronRight className="size-4" />
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
