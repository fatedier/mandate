import { ChevronDown, Keyboard, Maximize2, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
 } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { RefreshButton } from "@/components/RefreshButton";

interface TerminalHeaderProps {
  isMobile: boolean;
  titleText: string;
  path: string;
  statusOk: boolean;
  status: "idle" | "connecting" | "connected" | "error" | "disconnected";
  statusDotClass: string;
  windowZoomed: boolean;
  fitWidth: boolean;
  fitBrowserUser: boolean;
  keysVisible: boolean;
  onToggleFitWidth: () => void;
  onToggleBrowserFit: () => void;
  onToggleKeysVisible: () => void;
  onRefresh: () => void;
  /** Phone only: the header title becomes the pane switcher's trigger. */
  switcher?: { windowName: string; paneIndex: number | null; open: boolean; onToggle: () => void };
}

export function TerminalHeader({
  isMobile,
  titleText,
  path,
  statusOk,
  status,
  statusDotClass,
  windowZoomed,
  fitWidth,
  fitBrowserUser,
  keysVisible,
  onToggleFitWidth,
  onToggleBrowserFit,
  onToggleKeysVisible,
  onRefresh,
  switcher
}: TerminalHeaderProps) {
  return (
    <header
      className={cn(
        "relative z-30 flex items-center gap-2 border-b border-border-soft bg-panel",
        isMobile ? "px-2 py-1" : "px-4 py-3"
      )}
    >
      {isMobile && switcher ? (
        <>
          <button
            type="button"
            aria-label="Switch window or pane"
            aria-expanded={switcher.open}
            onClick={switcher.onToggle}
            className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left transition-colors hover:bg-sel"
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{switcher.windowName}</span>
            <span className="shrink-0 text-faint">/</span>
            {switcher.paneIndex != null && <span className="shrink-0 font-mono text-2xs text-faint">[{switcher.paneIndex}]</span>}
            <span className="min-w-0 truncate text-xs font-semibold">{titleText}</span>
            <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", switcher.open && "rotate-180")} aria-hidden />
          </button>
          {statusOk ? (
            <span className="h-1.5 w-1.5 rounded-full bg-green shrink-0" aria-label="connected" />
          ) : (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs shrink-0",
                status === "connecting" && "border-border text-muted-foreground",
                (status === "error" || status === "disconnected") && "border-red/40 text-red"
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass)} aria-hidden="true" />
              {status}
            </span>
          )}
          {windowZoomed && (
            <span className="text-2xs text-amber shrink-0">zoomed</span>
          )}
        </>
      ) : (
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {path && (
            <span className="text-2xs font-mono text-chrome truncate min-w-0">
              {path}
            </span>
          )}
          <h2 className="text-sm font-mono font-semibold truncate shrink-0 max-w-[40%]">
            {titleText}
          </h2>
          {statusOk ? (
            <span className="h-1.5 w-1.5 rounded-full bg-green shrink-0" aria-label="connected" />
          ) : (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs shrink-0",
                status === "connecting" && "border-border text-muted-foreground",
                (status === "error" || status === "disconnected") && "border-red/40 text-red"
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass)} aria-hidden="true" />
              {status}
            </span>
          )}
          {windowZoomed && (
            <span className="text-2xs text-amber shrink-0">zoomed</span>
          )}
        </div>
      )}
      {isMobile ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Terminal actions"
              className="text-chrome hover:text-foreground shrink-0"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onToggleFitWidth}>
              <Maximize2 className="h-4 w-4" />
              {fitWidth ? "Actual width" : "Fit width"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleKeysVisible}>
              <Keyboard className="h-4 w-4" />
              {keysVisible ? "Hide keys" : "Show keys"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleBrowserFit}>
              <Maximize2 className="h-4 w-4" />
              {fitBrowserUser ? "Release web fit" : "Web fit"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRefresh}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <Button variant="outline" size="sm" onClick={onToggleBrowserFit}>
            <Maximize2 className="h-4 w-4" />
            {fitBrowserUser ? "Release fit" : "Fit browser"}
          </Button>
          <RefreshButton what="pane" onRefresh={onRefresh} />
        </div>
      )}
    </header>
  );
}
