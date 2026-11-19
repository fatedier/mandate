import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Keyboard, Monitor, MoreHorizontal, Pin, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { TerminalDisplay } from "@/store/ui";
import { TERMINAL_DISPLAY_COPY, displayChoices, displayHere } from "./terminal-display";
import { DisplayPicture } from "./DisplayPicture";
import { cn } from "@/lib/utils";
import { RefreshButton } from "@/components/RefreshButton";

type TerminalStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error" | "closed";

/** What a terminal's controls act on: its view of the pane, and the pane. */
export interface TerminalControlProps {
  isMobile: boolean;
  status: TerminalStatus;
  windowZoomed: boolean;
  /** Display as chosen on this device (a phone's smaller text reads as the
   *  pane's size on a desktop). */
  display: TerminalDisplay;
  keysVisible: boolean;
  onDisplay: (display: TerminalDisplay) => void;
  onToggleKeysVisible: () => void;
  onRefresh: () => void;
  /** The ⋯ menu closed: what is focused next (the terminal, after a choice
   *  that asked for it; the menu's button otherwise). */
  onMenuCloseAutoFocus?: (event: Event) => void;
}

export interface TerminalHeaderProps extends TerminalControlProps {
  titleText: string;
  path: string;
  /** Phone only: the header title becomes the pane switcher's trigger. */
  switcher?: { windowName: string; paneIndex: number | null; open: boolean; onToggle: () => void };
}

/** The connection's state (a dot while connected; a closed terminal's notice
 *  says it), and "zoomed" while its window is. */
function ConnectionMarks({ status, windowZoomed }: { status: TerminalStatus; windowZoomed: boolean }) {
  const statusDotClass =
    status === "connected" ? "bg-phase-done" :
    status === "connecting" || status === "reconnecting" ? "bg-muted-foreground animate-pulse" :
    "bg-destructive";
  return (
    <>
      {status === "connected" ? (
        <span className="h-1.5 w-1.5 rounded-full bg-phase-done shrink-0" aria-label="connected" />
      ) : status === "closed" ? null : (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs shrink-0",
            (status === "connecting" || status === "reconnecting") && "border-border text-muted-foreground",
            status === "error" && "border-destructive/40 text-destructive"
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
  );
}

/** Display's choices: a picture, the name and a line on what it does; the
 *  one in use ticked, as a task's Status is. */
function DisplayChoices({ isMobile, display, onDisplay }: Pick<TerminalControlProps, "isMobile" | "display" | "onDisplay">) {
  const inUse = displayHere(display, isMobile);
  return displayChoices(isMobile).map((choice) => (
    <DropdownMenuItem key={choice} role="menuitemradio" aria-checked={choice === inUse} onSelect={() => onDisplay(choice)} className="gap-2.5">
      <DisplayPicture display={choice} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-slot="display-name">{TERMINAL_DISPLAY_COPY[choice].name}</span>
        <span data-slot="display-hint" className="text-xs leading-snug text-faint">{TERMINAL_DISPLAY_COPY[choice].hint}</span>
      </span>
      <Check aria-hidden className={cn("size-3.5 shrink-0", choice !== inUse && "invisible")} />
    </DropdownMenuItem>
  ));
}

/** "Display" and, beside it, the way in use. */
function DisplayLabel({ isMobile, display }: Pick<TerminalControlProps, "isMobile" | "display">) {
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
      Display
      <span data-slot="menu-value" className="truncate text-xs text-faint">{TERMINAL_DISPLAY_COPY[displayHere(display, isMobile)].name}</span>
    </span>
  );
}

/** A view's options: Display (its choices beside the menu; on a phone, which
 *  has no room beside it, in its place: `onChooseDisplay`), the keys and
 *  Refresh. */
function ViewItems({ isMobile, display, keysVisible, onDisplay, onToggleKeysVisible, onRefresh, onChooseDisplay }: TerminalControlProps & { onChooseDisplay: () => void }) {
  return (
    <>
      {isMobile ? (
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); onChooseDisplay(); }}>
          <Monitor className="h-4 w-4" />
          <DisplayLabel isMobile display={display} />
          <ChevronRight aria-hidden className="size-3.5 text-faint" />
        </DropdownMenuItem>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Monitor className="h-4 w-4" />
            <DisplayLabel isMobile={false} display={display} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-2rem)]">
            <DisplayChoices isMobile={false} display={display} onDisplay={onDisplay} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuItem onSelect={onToggleKeysVisible}>
        <Keyboard className="h-4 w-4" />
        {keysVisible ? "Hide keys" : "Show keys"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onRefresh}>
        <RefreshCw className="h-4 w-4" />
        Refresh
      </DropdownMenuItem>
    </>
  );
}

/** Moving the shown terminal's tab one place along its group (the Terminals
 *  page): a way that is not a drag. A side it cannot go is left out. */
export interface TerminalTabMove {
  left?: () => void;
  right?: () => void;
}

/** The ⋯ menu's body: where the terminal is, Pin, and on the Terminals page
 *  Move left / Move right, then the view's options; on a phone Display's
 *  choices take the menu's place, under a way back. It opens on the options
 *  again (a closed menu's body goes). */
function MenuBody({ place, pin, move, ...props }: TerminalControlProps & {
  place?: string;
  pin?: { pinned: boolean; onToggle: () => void };
  move?: TerminalTabMove;
}) {
  const [choosing, setChoosing] = useState(false);
  if (props.isMobile && choosing) {
    return (
      <>
        <DropdownMenuItem data-slot="menu-back" onSelect={(event) => { event.preventDefault(); setChoosing(false); }}>
          <ChevronLeft className="h-4 w-4" />
          Display
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DisplayChoices isMobile display={props.display} onDisplay={props.onDisplay} />
      </>
    );
  }
  return (
    <>
      {place && <DropdownMenuLabel className="truncate font-mono text-2xs font-normal text-faint">{place}</DropdownMenuLabel>}
      {pin && (
        <DropdownMenuItem onSelect={pin.onToggle}>
          <Pin className={cn("h-4 w-4", pin.pinned && "fill-current")} />
          {pin.pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
      )}
      {move && (
        <>
          <DropdownMenuItem disabled={!move.left} onSelect={move.left}>
            <ArrowLeft className="h-4 w-4" />
            Move left
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!move.right} onSelect={move.right}>
            <ArrowRight className="h-4 w-4" />
            Move right
          </DropdownMenuItem>
        </>
      )}
      {(place || pin || move) && <DropdownMenuSeparator />}
      <ViewItems {...props} onChooseDisplay={() => setChoosing(true)} />
    </>
  );
}

const menuTrigger = (
  <DropdownMenuTrigger asChild>
    <Button variant="ghost" size="icon-sm" aria-label="Terminal actions" className="text-chrome hover:text-foreground shrink-0">
      <MoreHorizontal className="h-4 w-4" />
    </Button>
  </DropdownMenuTrigger>
);

/** A terminal's controls at the end of a tab row (the Terminals page, the
 *  personal agent's panel), where its tab names it: the connection's marks
 *  and ⋯, which says first where the terminal is (a phone has no tooltip),
 *  then Pin or Unpin, then the view's options. */
export function TerminalControls({ place, pin, move, ...props }: TerminalControlProps & {
  /** `command · session › window · folder` */
  place?: string;
  pin?: { pinned: boolean; onToggle: () => void };
  move?: TerminalTabMove;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 pointer-coarse:gap-2">
      <ConnectionMarks status={props.status} windowZoomed={props.windowZoomed} />
      <DropdownMenu>
        {menuTrigger}
        <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]" onCloseAutoFocus={props.onMenuCloseAutoFocus}>
          <MenuBody place={place} pin={pin} move={move} {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** A worker's terminal's own header: where it is and what it is, its
 *  connection, and its controls. */
export function TerminalHeader({ titleText, path, switcher, ...props }: TerminalHeaderProps) {
  const { isMobile, display, onDisplay, onRefresh, keysVisible, onToggleKeysVisible } = props;
  const marks = <ConnectionMarks status={props.status} windowZoomed={props.windowZoomed} />;
  return (
    <header
      className={cn(
        "relative z-30 flex items-center gap-2 border-b border-border-soft bg-panel",
        // On a touch screen its 32px buttons' 44px touch areas stay inside
        // it, clear of what is above.
        isMobile ? "px-2 py-1 pointer-coarse:py-1.5" : "px-4 py-3"
      )}
    >
      {isMobile && switcher ? (
        <>
          <button
            type="button"
            aria-label="Switch window or pane"
            aria-expanded={switcher.open}
            onClick={switcher.onToggle}
            className="hit relative flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left transition-colors hover:bg-sel"
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{switcher.windowName}</span>
            <span className="shrink-0 text-faint">/</span>
            {switcher.paneIndex != null && <span className="shrink-0 font-mono text-2xs text-faint">[{switcher.paneIndex}]</span>}
            <span className="min-w-0 truncate text-xs font-semibold">{titleText}</span>
            <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", switcher.open && "rotate-180")} aria-hidden />
          </button>
          {marks}
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
          {marks}
        </div>
      )}
      {isMobile ? (
        <DropdownMenu>
          {menuTrigger}
          <DropdownMenuContent align="end">
            <MenuBody {...props} />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <Button variant="outline" size="sm" onClick={onToggleKeysVisible}>
            <Keyboard className="h-4 w-4" />
            {keysVisible ? "Hide keys" : "Show keys"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Monitor className="h-4 w-4" />
                Display
                <span data-slot="menu-value" className="text-faint">{TERMINAL_DISPLAY_COPY[displayHere(display, false)].name}</span>
                <ChevronDown className="size-3.5 text-faint" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DisplayChoices isMobile={false} display={display} onDisplay={onDisplay} />
            </DropdownMenuContent>
          </DropdownMenu>
          <RefreshButton what="pane" onRefresh={onRefresh} />
        </div>
      )}
    </header>
  );
}
