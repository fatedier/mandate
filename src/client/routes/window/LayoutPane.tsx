import { useEffect, useRef, useState, type SyntheticEvent } from "react";
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
import { paneStatus, paneTitle, statusBorderClass } from "@/routes/window/pane-helpers";
import { getPaneDisplayCommand } from "@/lib/render";
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
  // Tiny cells skip the preview entirely (no room for it). Otherwise the
  // preview is a clipped block: short previews sit at the top, overflowing
  // ones are pinned to the bottom (latest output) by the scroll effect below.
  const tiny = width < 18 || height < 22;
  const status = paneStatus(pane);
  // A whitespace-only name counts as no name: the command leads, in mono.
  const name = pane.metadata?.name?.trim();
  // Not `pane.currentCommand`: that is the wrapper tmux reports (node, npm,
  // env…); the display command looks through it to the real foreground process.
  const command = getPaneDisplayCommand(pane);

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

  // The preview is `overflow-hidden`: the reader cannot scroll it, so there is
  // no "scrolled away" state to respect. Every new snapshot pins the block to
  // its bottom, where the latest output is; scrollTop on a clipped element
  // still moves the content.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [preview]);

  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      data-slot="pane-panel"
      className={cn(
        "absolute group flex flex-col overflow-hidden rounded-lg border border-border-soft bg-panel text-left cursor-pointer transition-colors",
        "hover:border-border focus-visible:ring-2 focus-visible:ring-ring outline-none",
        statusBorderClass(pane)
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
      <span className="flex h-9 shrink-0 items-center gap-2 border-b border-border-soft px-3.5">
        <span data-slot="pane-index" className="num font-mono w-[22px] shrink-0 text-2xs text-faint">[{pane.paneIndex}]</span>
        <span
          data-slot="pane-name"
          className={cn("min-w-0 truncate text-xs font-medium text-foreground", !name && "font-mono")}
          title={pane.metadata?.description || undefined}
        >
          {name || paneTitle(pane)}
        </span>
        {name && command && (
          <span data-slot="pane-command" className="shrink-0 font-mono text-2xs text-faint">{command}</span>
        )}
        <span className="flex-1" />
        <span data-slot="pane-dot" className="shrink-0 cursor-default" onClick={stop} onKeyDown={stop}>
          <StatusDot status={status} />
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            data-slot="pane-menu"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-chrome hover:bg-sel hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Pane actions"
            onClick={stop}
            onKeyDown={stop}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={stop}>
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
      {!tiny && (
        <div
          ref={scrollRef}
          data-slot="pane-preview"
          className={cn(
            "min-h-0 flex-1 overflow-hidden bg-code-bg px-3.5 py-2 font-mono text-2xs leading-[17px] text-muted-foreground whitespace-pre",
            !preview && "text-faint"
          )}
        >
          {preview || "No captured output yet."}
        </div>
      )}
    </div>
  );
}
