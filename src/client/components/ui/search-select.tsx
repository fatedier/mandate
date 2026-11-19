import * as React from "react";
import { Command } from "cmdk";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export type SearchSelectOption = {
  value: string;
  /** Matched against what the reader types, so it is text. */
  label: string;
};

/** cmdk keys its items by a non-empty value; the any-option's is "". */
const ANY = "__mandate_search_any__";
const itemValue = (value: string) => (value === "" ? ANY : value);

/**
 * A select whose list a reader can narrow by typing: for a list too long to
 * scan (every model the log has). Opened, a search box sits over the list;
 * what is typed keeps the options whose name holds it, in any case, and marks
 * it. ↑↓ move, Enter picks, Escape closes. The option whose value is "" (Any
 * …) is the choice of none: it is listed while nothing is typed.
 *
 * The keyboard and the listbox are cmdk's; the surface is the app's popover.
 */
export function SearchSelect({
  value,
  options,
  searchPlaceholder,
  className,
  contentClassName,
  itemClassName,
  "aria-label": ariaLabel,
  onValueChange
}: {
  value: string;
  options: ReadonlyArray<SearchSelectOption>;
  searchPlaceholder: string;
  className?: string;
  contentClassName?: string;
  itemClassName?: string;
  "aria-label": string;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const chosen = options.find((option) => option.value === value) ?? options.find((option) => option.value === "");
  const typed = query.trim().toLowerCase();
  const shown = typed
    ? options.filter((option) => option.value !== "" && option.label.toLowerCase().includes(typed))
    : options;
  // The highlighted option: the chosen one as the list opens, then the first
  // match as the search changes, so Enter takes what the reader is looking at.
  const [highlight, setHighlight] = React.useState(itemValue(value));

  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      setHighlight(itemValue(value));
    }
  };
  const search = (next: string) => {
    setQuery(next);
    const lower = next.trim().toLowerCase();
    const first = lower
      ? options.find((option) => option.value !== "" && option.label.toLowerCase().includes(lower))
      : options[0];
    if (first) setHighlight(itemValue(first.value));
  };
  const pick = (option: SearchSelectOption) => {
    setOpen(false);
    onValueChange(option.value);
  };

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            "hit relative flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors hover:border-border-soft focus:border-ring focus:ring-[3px] focus:ring-ring/20",
            className
          )}
        >
          <span className="min-w-0 truncate">{chosen?.label}</span>
          <ChevronDownIcon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      {/* Kept clear of the screen's edges: on a phone it is nearly as wide as
          the screen, and flush against one edge it reads as cut off. No
          taller than the room beside the trigger (a phone's keyboard takes
          half the screen): the search box stays on screen and the list
          scrolls under it. */}
      <PopoverContent
        collisionPadding={8}
        className={cn(
          "flex max-h-[var(--radix-popover-content-available-height)] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden p-0",
          contentClassName
        )}
        // An input method cancels what it is composing with Escape: that
        // Escape is the input method's, not a request to close.
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <Command
          shouldFilter={false}
          loop
          label={ariaLabel}
          value={highlight}
          onValueChange={setHighlight}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Command.Input
            value={query}
            onValueChange={search}
            placeholder={searchPlaceholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-9 w-full shrink-0 border-b border-border-soft bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-chrome"
          />
          <Command.List className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-2.5 text-xs text-faint">No match</Command.Empty>
            {shown.map((option) => (
              <Command.Item
                key={itemValue(option.value)}
                value={itemValue(option.value)}
                onSelect={() => pick(option)}
                data-chosen={option.value === chosen?.value ? "" : undefined}
                className={cn(
                  "relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none pointer-coarse:min-h-11 data-[selected=true]:bg-sel",
                  itemClassName
                )}
              >
                <span className="min-w-0 truncate">{marked(option.label, typed)}</span>
                {option.value === chosen?.value && (
                  <CheckIcon aria-hidden className="absolute right-2 h-4 w-4" />
                )}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The label with the first stretch that matches the search set apart. */
function marked(label: string, typed: string): React.ReactNode {
  if (!typed) return label;
  const at = label.toLowerCase().indexOf(typed);
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="bg-transparent font-semibold text-foreground">{label.slice(at, at + typed.length)}</mark>
      {label.slice(at + typed.length)}
    </>
  );
}
