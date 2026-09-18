import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

interface PaneCardMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Title attribute for the menu item — useful when disabled, to explain why. */
  title?: string;
  /** Optional leading icon, matched to LayoutPane's menu style. */
  icon?: ReactNode;
  /** Mark as destructive (renders in red, matches LayoutPane's "Close pane"
   *  styling). Uses radix-ui's data-variant attribute under the hood. */
  destructive?: boolean;
}

interface PaneCardShellProps {
  title: string;
  /** Set the title in mono when it is a command rather than a human name. */
  titleMono?: boolean;
  /** Status indicator slot — the parent decides what dot/badge to render so
   *  this layout stays decoupled from status semantics. */
  statusIndicator?: ReactNode;
  /** Sub-row under the title: cwd, time, pid — anything tabular. */
  metadata?: ReactNode;
  /** Optional scrollback preview block. */
  preview?: string;
  menuItems: PaneCardMenuItem[];
  /** Primary action — fired when the user clicks anywhere on the card body
   *  (matches LayoutPane's "click pane to open terminal" UX). The kebab
   *  trigger stops propagation so the menu doesn't double-fire. Disabled
   *  cards skip the click handler and drop the cursor/focus affordances. */
  onActivate?: () => void;
  activateDisabled?: boolean;
}

/** Shared layout for pane rows. Callers pass their own status indicator and
 *  metadata; this component only owns the visual frame. */
export function PaneCardShell({
  title,
  titleMono = false,
  statusIndicator,
  metadata,
  preview,
  menuItems,
  onActivate,
  activateDisabled
}: PaneCardShellProps) {
  const clickable = !!onActivate && !activateDisabled;
  const handleActivate = () => {
    if (clickable) onActivate!();
  };
  return (
    <article
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? handleActivate : undefined}
      onKeyDown={clickable ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleActivate();
        }
      } : undefined}
      data-slot="pane-card"
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border-soft bg-panel transition-colors",
        clickable && "cursor-pointer hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      )}
    >
      <header className="flex h-9 items-center gap-2 border-b border-border-soft px-3.5">
        <span data-slot="pane-name" className={cn("min-w-0 truncate text-xs font-medium text-foreground", titleMono && "font-mono")}>{title}</span>
        {statusIndicator && <span data-slot="pane-dot" className="shrink-0">{statusIndicator}</span>}
        <div className="ml-auto shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger
              data-slot="pane-menu"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-chrome hover:bg-sel hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label="Pane actions"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              {menuItems.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  onSelect={item.onSelect}
                  disabled={item.disabled}
                  title={item.title}
                  variant={item.destructive ? "destructive" : "default"}
                >
                  {item.icon}
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {metadata && (
        <div className="flex min-w-0 items-center gap-2 px-3.5 py-1.5 font-mono text-2xs text-faint">
          {metadata}
        </div>
      )}
      {preview && <PaneCardPreview preview={preview} />}
    </article>
  );
}

/** Preview block that pins itself to the bottom (latest terminal output) on
 *  first render and after each preview update: a live tail, not a static log
 *  dump. The box is overflow-hidden, so the reader can never scroll it up —
 *  there is no "reading history" state to preserve, and an earlier
 *  was-at-bottom guard here could only ever be true. */
function PaneCardPreview({ preview }: { preview: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [preview]);
  return (
    <div
      ref={scrollRef}
      data-slot="pane-preview"
      className="max-h-[120px] overflow-hidden bg-code-bg px-3.5 py-2 font-mono text-2xs leading-[17px] text-muted-foreground whitespace-pre md:max-h-56"
    >
      {preview}
    </div>
  );
}
