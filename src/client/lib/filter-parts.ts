/** The pieces a list's filters are made of, shared by the pages that have
 *  them (Tasks, Threads): a menu's trigger's and Clear filters' classes, the
 *  count's words, No label / No project and Select all. The components:
 *  components/FilterParts.tsx. */

/** A filter menu's trigger, or a phone's one Filter button. */
export const FILTER_TRIGGER = "flex h-7 shrink-0 items-center gap-1 rounded-md border border-border-soft bg-background px-2 text-xs text-muted-foreground hover:text-foreground data-[state=open]:text-foreground";
/** The trigger while something of its is ticked. */
export const FILTER_TRIGGER_ON = "border-ring/60 text-foreground";
/** Clear filters, as a bar, a sheet and an empty list say it. */
export const FILTER_CLEAR = "shrink-0 rounded-xs text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";

/** The choice for the items that have none: No label, No project. Kept
 *  with the names ticked; a label's or a project's name is never empty. */
export const NO_VALUE = "";

/** Select all over a filter's choices: ticked when every one is, a dash
 *  ("indeterminate") when some are; pressed, it ticks them all, or none
 *  when all are ticked. Null for a filter of fewer than two choices. */
export function selectAll<T extends string>(ids: readonly T[], ticked: (id: T) => boolean): { checked: boolean | "indeterminate"; next: T[] } | null {
  if (ids.length < 2) return null;
  const count = ids.filter((id) => ticked(id)).length;
  const all = count === ids.length;
  return { checked: all ? true : count > 0 ? "indeterminate" : false, next: all ? [] : [...ids] };
}

/** A filter's name, with how many of its values are ticked when any is. */
export const filterCount = (name: string, ticked: number): string => (ticked > 0 ? `${name} · ${ticked}` : name);
