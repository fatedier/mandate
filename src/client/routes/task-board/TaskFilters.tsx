import { ChevronDown, Cog, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { FilterMenuChoices, FilterSheetChoices, FilterSheetGroup, type FilterChoice, type FilterChoicesProps } from "@/components/FilterParts";
import { FILTER_CLEAR, FILTER_TRIGGER, FILTER_TRIGGER_ON, NO_VALUE, filterCount } from "@/lib/filter-parts";
import { cn } from "@/lib/utils";
import { useTaskBoardStore, type DueFilter } from "@/store/task-board";
import type { TaskDto } from "@shared/api/task-board";
import { boardLabels } from "./task-format";

const DUE_CHOICES: ReadonlyArray<FilterChoice<DueFilter>> = [
  { id: "overdue", label: "Overdue" },
  { id: "week", label: "This week" },
  { id: "none", label: "No due date" }
];

/** The two filters' choices and ticks: Label lists the board's labels,
 *  automatic ones first, then No label, under Select all; Due its three. */
function useFilterGroups(tasks: readonly TaskDto[]) {
  const filters = useTaskBoardStore((s) => s.filters);
  const store = useTaskBoardStore.getState;
  const label: FilterChoicesProps = {
    choices: [
      ...boardLabels(tasks).map((l) => ({ id: l.name, label: <>{l.auto && <Cog aria-hidden className="size-3.5 text-live" />}{l.name}</> })),
      { id: NO_VALUE, label: "No label" }
    ],
    ticked: (name) => filters.labels.some((l) => l.toLowerCase() === name.toLowerCase()),
    onToggle: (name) => store().toggleLabelFilter(name),
    onTickOnly: (names) => store().setLabelFilter(names)
  };
  const due: FilterChoicesProps<DueFilter> = {
    choices: DUE_CHOICES,
    ticked: (id) => filters.due.includes(id),
    onToggle: (id) => store().toggleDueFilter(id)
  };
  return { filters, label, due };
}

/** Clear filters, as the bar and the empty board say it. */
export function ClearFilters({ className }: { className?: string }) {
  return (
    <button type="button" className={cn(FILTER_CLEAR, className)} onClick={() => useTaskBoardStore.getState().clearFilters()}>
      Clear filters
    </button>
  );
}

/** The board's filter bar on a desktop: Label and Due, each a menu of
 *  checkboxes; Clear filters while any is ticked. */
export function TaskFilterBar({ tasks }: { tasks: readonly TaskDto[] }) {
  const { filters, label, due } = useFilterGroups(tasks);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-slot="task-filter-label" className={cn(FILTER_TRIGGER, filters.labels.length > 0 && FILTER_TRIGGER_ON)}>
            {filterCount("Label", filters.labels.length)}<ChevronDown aria-hidden className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-44 overflow-y-auto">
          <FilterMenuChoices {...label} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-slot="task-filter-due" className={cn(FILTER_TRIGGER, filters.due.length > 0 && FILTER_TRIGGER_ON)}>
            {filterCount("Due", filters.due.length)}<ChevronDown aria-hidden className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          <FilterMenuChoices {...due} />
        </DropdownMenuContent>
      </DropdownMenu>
      {(filters.labels.length > 0 || filters.due.length > 0) && <ClearFilters />}
    </>
  );
}

/** A phone's one Filter button, with how many are ticked; it opens the
 *  same two groups in a sheet. */
export function TaskFilterPhone({ tasks }: { tasks: readonly TaskDto[] }) {
  const { filters, label, due } = useFilterGroups(tasks);
  const [open, setOpen] = useState(false);
  const total = filters.labels.length + filters.due.length;
  return (
    <>
      <button type="button" data-slot="task-filter-phone" onClick={() => setOpen(true)} className={cn(FILTER_TRIGGER, "h-9 px-3", total > 0 && FILTER_TRIGGER_ON)}>
        <SlidersHorizontal aria-hidden className="size-3.5" />{filterCount("Filter", total)}
      </button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        slot="task-filter-sheet"
        bodyClassName="flex flex-col gap-1 px-2 pb-4"
        header={<div className="flex h-8 items-center px-4"><BottomSheetTitle className="text-sm font-semibold">Filter tasks</BottomSheetTitle></div>}
      >
        <FilterSheetGroup first>Label</FilterSheetGroup>
        <FilterSheetChoices {...label} />
        <FilterSheetGroup>Due</FilterSheetGroup>
        <FilterSheetChoices {...due} />
        {total > 0 && <ClearFilters className="mx-3 mt-2 self-start py-2" />}
      </BottomSheet>
    </>
  );
}
