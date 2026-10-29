import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { composerOptionId } from "./composer-option-id";

export interface ComposerListOption {
  key: string;
  content: ReactNode;
  /** Data attributes set on the option itself (a command's `data-blocked`). */
  attributes?: Record<`data-${string}`, string>;
}

export interface ComposerListGroup {
  heading?: string;
  options: readonly ComposerListOption[];
}

/** What the composer shows over itself as you type: its commands, or what an
 *  @ can name. One listbox, read from the textarea (the caret never leaves
 *  it: a press is taken on the way down). Groups with a heading are named
 *  groups; past about eight rows the list scrolls in itself. `rowClassName`
 *  lays out an option's own content. */
export function ComposerList({ id, label, groups, picked, rowClassName, onPick }: {
  id: string;
  label: string;
  groups: readonly ComposerListGroup[];
  /** The index of the picked option, counted across every group. */
  picked: number;
  rowClassName?: string;
  onPick: (key: string) => void;
}) {
  // The caret stays in the textarea, so nothing scrolls the list for it: a
  // pick moved past its height is brought into view here, by scrolling the
  // list alone (scrollIntoView would move the page around it too, as on an
  // iPhone with the keyboard open).
  const listRef = useRef<HTMLDivElement>(null);
  const pickedKey = groups.flatMap((group) => group.options)[picked]?.key;
  useEffect(() => {
    const list = listRef.current;
    if (pickedKey === undefined || !list) return;
    const optionId = composerOptionId(id, pickedKey);
    const row = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.id === optionId);
    if (!row) return;
    const box = list.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < box.top) list.scrollTop -= box.top - at.top;
    else if (at.bottom > box.bottom) list.scrollTop += at.bottom - box.bottom;
  }, [id, pickedKey]);
  // Where each group's options start, counted across the whole list.
  const starts = groups.map((_, g) => groups.slice(0, g).reduce((sum, group) => sum + group.options.length, 0));
  const option = (o: ComposerListOption, index: number) => {
    const selected = index === picked;
    return (
      <div
        key={o.key}
        id={composerOptionId(id, o.key)}
        role="option"
        aria-selected={selected}
        {...o.attributes}
        onMouseDown={(event) => { event.preventDefault(); onPick(o.key); }}
        // 44px on a touch screen, where a row's words may take two lines.
        className={cn("flex min-w-0 cursor-pointer rounded-sm px-2.5 py-1.5 pointer-coarse:min-h-11", rowClassName, selected && "bg-sel")}
      >
        {o.content}
      </div>
    );
  };
  return (
    <div ref={listRef} id={id} role="listbox" aria-label={label} className="flex max-h-72 flex-col overflow-y-auto">
      {groups.map((group, g) => group.heading
        ? (
          <div key={group.heading} role="group" aria-label={group.heading} className="flex flex-col">
            <div aria-hidden className="px-2.5 pt-1 pb-1.5 text-2xs text-faint">{group.heading}</div>
            {group.options.map((o, i) => option(o, starts[g]! + i))}
          </div>
        )
        : <Fragment key={`group-${g}`}>{group.options.map((o, i) => option(o, starts[g]! + i))}</Fragment>
      )}
    </div>
  );
}
