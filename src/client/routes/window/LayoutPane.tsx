import { useEffect, useRef, useState } from "react";
import {
  MoreHorizontal,
  Terminal as TerminalIcon,
  X,
  SplitSquareHorizontal,
  SplitSquareVertical
} from "lucide-react";
import type { SnapshotPane } from "@/lib/snapshot-types";
import type { TmuxLayoutLeaf } from "@/lib/tmux";
import { StatusDot } from "@/components/StatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { paneStatus, paneStatusClass, paneTitle } from "@/routes/window/pane-helpers";
import { useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-paths";
import { toast } from "sonner";
import { confirmAction } from "@/components/confirm-action";
import type { PaneSplitRequest } from "@shared/api-contracts";

interface LayoutPaneProps {
  pane: SnapshotPane;
  leaf: TmuxLayoutLeaf;
  parsedWidth: number;
  parsedHeight: number;
  paneHref: (pane: SnapshotPane) => string | null;
  // Called after a successful split / close. Managed views rely on the SSE
  // snapshot stream and don't need this; the standalone WindowDetailPage
  // uses one-shot fetches and passes its refresh to keep the board in sync.
  onAfterChange?: () => void;
}

export function LayoutPane({ pane, leaf, parsedWidth, parsedHeight, paneHref, onAfterChange }: LayoutPaneProps) {
  const left = (leaf.x / parsedWidth) * 100;
  const top = (leaf.y / parsedHeight) * 100;
  const width = (leaf.width / parsedWidth) * 100;
  const height = (leaf.height / parsedHeight) * 100;
  // Tiny cells skip the preview entirely (no room for it). Otherwise show the
  // full preview bottom-aligned with overflow clipping — long previews fill
  // the card from the bottom up, short ones land at the bottom.
  const tiny = width < 18 || height < 22;
  const status = paneStatus(pane);

  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);

  const handleTerminal = () => {
    const href = paneHref(pane);
    if (href) navigate(href);
  };

  const handleSplit = async (direction: "right" | "down") => {
    if (!pane.paneId) return;
    try {
      const r = await fetch(api.paneSplit(pane.paneId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction } satisfies PaneSplitRequest)
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        toast.error(`Split failed: ${body.error ?? r.statusText}`);
        return;
      }
      onAfterChange?.();
    } catch (err) {
      toast.error(`Split failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleClose = async () => {
    if (!pane.paneId || closing) return;
    if (!(await confirmAction({
      title: `Close pane "${paneTitle(pane)}"?`,
      description: "Anything running in it will be killed.",
      confirmLabel: "Close",
      destructive: true
    }))) return;
    setClosing(true);
    try {
      const r = await fetch(api.paneById(pane.paneId), { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        toast.error(`Close failed: ${body.error ?? r.statusText}`);
        return;
      }
      onAfterChange?.();
    } catch (err) {
      toast.error(`Close failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClosing(false);
    }
  };

  const preview = tiny ? "" : (pane.preview ?? "");

  // Pin scroll position to the bottom by default (latest terminal output is at
  // the bottom). When the preview text changes (new SSE snapshot) and the user
  // hasn't scrolled away from the bottom, snap back. Compare against the
  // PREVIOUS scrollHeight so the first render (when prev = 0) always scrolls.
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollHeightRef = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wasAtBottom = el.scrollTop + el.clientHeight >= lastScrollHeightRef.current - 24;
    if (wasAtBottom) {
      el.scrollTop = el.scrollHeight;
    }
    lastScrollHeightRef.current = el.scrollHeight;
  }, [preview]);

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "absolute group flex flex-col gap-1 p-2 rounded-md text-left overflow-hidden border border-border-soft bg-card cursor-pointer transition-colors",
        "hover:border-border focus-visible:ring-2 focus-visible:ring-ring outline-none",
        paneStatusClass(pane)
      )}
      style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
      onClick={handleTerminal}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          handleTerminal();
        }
      }}
    >
      <span className="flex items-center justify-between gap-1 min-w-0">
        <span className="font-mono text-2xs font-semibold truncate" title={pane.metadata?.description || undefined}>
          {paneTitle(pane)}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <span
            className="shrink-0 cursor-default"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <StatusDot status={status} />
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex h-7 w-7 -m-1 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-background/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label="Pane actions"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={handleTerminal}>
                <TerminalIcon className="h-4 w-4" />
                Terminal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { void handleSplit("right"); }}>
                <SplitSquareHorizontal className="h-4 w-4" />
                Split right
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { void handleSplit("down"); }}>
                <SplitSquareVertical className="h-4 w-4" />
                Split down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => { void handleClose(); }}
                className="text-red"
                disabled={closing}
              >
                <X className="h-4 w-4" />
                {closing ? "Closing..." : "Close pane"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </span>
      {!tiny && (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 flex flex-col-reverse overflow-hidden md:flex-col md:overflow-y-auto md:overscroll-contain md:scrollbar-thin"
        >
          <pre className="m-0 text-2xs text-muted-foreground font-mono leading-snug whitespace-pre-wrap break-words">
            {preview || "No captured output yet."}
          </pre>
        </div>
      )}
    </div>
  );
}
