import { forwardRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { controlCodeFromInput } from "@/routes/terminal/terminal-input-codes";

interface MobileInputBarProps {
  sendInput: (data: string) => void;
  focusTerminal: () => void;
  ctrlActive: boolean;
  altActive: boolean;
  onToggleCtrl: () => void;
  onToggleAlt: () => void;
  onClearModifiers: () => void;
}

type Modifier = "ctrl" | "alt";

interface ExtraKey {
  label: string;
  data?: string;
  ctrlData?: string;
  altData?: string;
  modifier?: Modifier;
  aria?: string;
}

const KEY_ROWS: ExtraKey[][] = [
  [
    { label: "ESC", data: "\x1b", aria: "Escape" },
    { label: "/", data: "/" },
    { label: "DEL", data: "\x1b[3~", aria: "Delete" },
    { label: "HOME", data: "\x01", ctrlData: "\x1b[1;5H" },
    { label: "↑", data: "\x1b[A", ctrlData: "\x1b[1;5A", altData: "\x1b[1;3A", aria: "Cursor up" },
    { label: "END", data: "\x05", ctrlData: "\x1b[1;5F" },
    { label: "PGUP", data: "\x1b[5~", ctrlData: "\x1b[5;5~", aria: "Page up" }
  ],
  [
    { label: "TAB", data: "\t" },
    { label: "CTRL", modifier: "ctrl", aria: "Control modifier" },
    { label: "ALT", modifier: "alt", aria: "Alt modifier" },
    { label: "←", data: "\x1b[D", ctrlData: "\x1b[1;5D", altData: "\x1bb", aria: "Cursor left" },
    { label: "↓", data: "\x1b[B", ctrlData: "\x1b[1;5B", altData: "\x1b[1;3B", aria: "Cursor down" },
    { label: "→", data: "\x1b[C", ctrlData: "\x1b[1;5C", altData: "\x1bf", aria: "Cursor right" },
    { label: "PGDN", data: "\x1b[6~", ctrlData: "\x1b[6;5~", aria: "Page down" }
  ]
];

export const MobileInputBar = forwardRef<HTMLDivElement, MobileInputBarProps>(function MobileInputBar(
  { sendInput, focusTerminal, ctrlActive, altActive, onToggleCtrl, onToggleAlt, onClearModifiers },
  ref
) {
  const handleKey = (key: ExtraKey) => {
    if (key.modifier === "ctrl") {
      onToggleCtrl();
      return;
    }
    if (key.modifier === "alt") {
      onToggleAlt();
      return;
    }

    let data = key.data ?? "";
    if (ctrlActive) data = key.ctrlData ?? controlCodeFromInput(data) ?? data;
    if (altActive) data = key.altData ?? (data ? `\x1b${data}` : data);
    if (data) sendInput(data);
    onClearModifiers();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, key: ExtraKey) => {
    const restoreTerminalFocus = document.activeElement instanceof HTMLTextAreaElement &&
      document.activeElement.classList.contains("xterm-helper-textarea");
    event.preventDefault();
    handleKey(key);
    if (restoreTerminalFocus) requestAnimationFrame(focusTerminal);
  };

  const handleButtonKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, key: ExtraKey) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleKey(key);
  };

  return (
    <div ref={ref} className="grid grid-cols-7 gap-1.5 p-1.5 bg-panel border-t border-border-soft">
      {KEY_ROWS.flat().map((key) => {
        const active = (key.modifier === "ctrl" && ctrlActive) || (key.modifier === "alt" && altActive);
        return (
          <button
            key={key.label}
            type="button"
            aria-label={key.aria ?? key.label}
            aria-pressed={key.modifier ? active : undefined}
            onPointerDown={(event) => handlePointerDown(event, key)}
            onKeyDown={(event) => handleButtonKeyDown(event, key)}
            className={cn(
              "h-8 min-w-0 rounded-md border border-border-soft bg-muted px-1 text-2xs font-semibold text-foreground hover:bg-muted/70",
              "font-mono tabular-nums",
              active && "border-border bg-sel text-foreground font-semibold"
            )}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
});
