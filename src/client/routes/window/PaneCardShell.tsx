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
      className={cn(
        "flex flex-col gap-2 p-3 rounded-lg border border-border-soft bg-card transition-colors",
        clickable && "cursor-pointer hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      )}
    >
      <header className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-xs font-semibold truncate">{title}</span>
        {statusIndicator}
        <div className="ml-auto shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label="Pane actions"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
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
        <div className="flex items-center gap-2 text-2xs text-chrome font-mono min-w-0">
          {metadata}
        </div>
      )}
      {preview && <PaneCardPreview preview={preview} />}
    </article>
  );
}

/** Preview block that pins itself to the bottom (latest terminal output) on
 *  first render and after each preview update — but only if the user hasn't
 *  scrolled up to read history. Mirrors LayoutPane's scroll-stickiness so
 *  the pane card behaves like a live tail, not a static log dump. */
function PaneCardPreview({ preview }: { preview: string }) {
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
      ref={scrollRef}
      className="max-h-32 md:max-h-56 overflow-hidden md:overflow-auto md:overscroll-contain scrollbar-thin"
    >
      <pre className="m-0 text-muted-foreground font-mono text-2xs leading-snug whitespace-pre-wrap break-words">
        {preview}
      </pre>
    </div>
  );
}
