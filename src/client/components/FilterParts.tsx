import type { ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { DropdownMenuCheckboxItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { selectAll } from "@/lib/filter-parts";
import { cn } from "@/lib/utils";

/** The components a list's filters are made of, shared by the pages that
 *  have them (Tasks, Threads): a filter's choices in its desktop menu or
 *  under its heading in a phone's sheet. Their classes and the count's
 *  words: lib/filter-parts.ts. */

/** One choice of a filter: what it keeps, and what it shows. */
export interface FilterChoice<T extends string = string> {
  id: T;
  label: ReactNode;
}

/** A filter's choices and what of them is ticked. */
export interface FilterChoicesProps<T extends string = string> {
  choices: readonly FilterChoice<T>[];
  ticked(id: T): boolean;
  onToggle(id: T): void;
  /** Ticks exactly these. Given, the choices are headed by Select all when
   *  there are two or more. */
  onTickOnly?(ids: T[]): void;
}

const SELECT_ALL = "Select all";

/** Select all for these choices, or null when they have none. */
function selectAllOf<T extends string>({ choices, ticked, onTickOnly }: FilterChoicesProps<T>) {
  const all = onTickOnly ? selectAll(choices.map((c) => c.id), ticked) : null;
  return all && onTickOnly ? { checked: all.checked, press: () => onTickOnly(all.next) } : null;
}

// A tick keeps the menu open, so several are one go.
const keepOpen = (event: Event) => { event.preventDefault(); };

/** A filter's choices in its desktop menu, a checkbox each. */
export function FilterMenuChoices<T extends string>(props: FilterChoicesProps<T>) {
  const all = selectAllOf(props);
  return (
    <>
      {all && (
        <>
          <DropdownMenuCheckboxItem checked={all.checked} onSelect={keepOpen} onCheckedChange={all.press}>{SELECT_ALL}</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
        </>
      )}
      {props.choices.map((choice) => (
        <DropdownMenuCheckboxItem key={choice.id} checked={props.ticked(choice.id)} onSelect={keepOpen} onCheckedChange={() => props.onToggle(choice.id)}>
          {choice.label}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

/** A filter's choices in a phone's sheet, under its group's heading. */
export function FilterSheetChoices<T extends string>(props: FilterChoicesProps<T>) {
  const all = selectAllOf(props);
  return (
    <>
      {all && <FilterSheetOption checked={all.checked} onToggle={all.press}>{SELECT_ALL}</FilterSheetOption>}
      {props.choices.map((choice) => (
        <FilterSheetOption key={choice.id} checked={props.ticked(choice.id)} onToggle={() => props.onToggle(choice.id)}>{choice.label}</FilterSheetOption>
      ))}
    </>
  );
}

/** A group's heading in a phone's filter sheet. */
export function FilterSheetGroup({ first = false, children }: { first?: boolean; children: ReactNode }) {
  return <p data-slot="filter-group" className={cn("px-3 text-xs font-medium text-faint", first ? "pt-1" : "pt-2")}>{children}</p>;
}

/** One choice in a phone's filter sheet: a row to tick. */
function FilterSheetOption({ checked, onToggle, children }: { checked: boolean | "indeterminate"; onToggle(): void; children: ReactNode }) {
  const on = checked !== false;
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked === "indeterminate" ? "mixed" : checked}
      onClick={onToggle}
      className="flex h-11 items-center gap-3 rounded-md px-3 text-left text-sm text-foreground hover:bg-sel"
    >
      <span aria-hidden className={cn("flex size-4 items-center justify-center rounded-xs border", on ? "border-status-review bg-status-review text-white" : "border-border")}>
        {checked === "indeterminate" ? <Minus className="size-3" /> : checked && <Check className="size-3" />}
      </span>
      {children}
    </button>
  );
}
