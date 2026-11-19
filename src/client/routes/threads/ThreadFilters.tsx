import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { FilterMenuChoices, FilterSheetChoices, FilterSheetGroup, type FilterChoicesProps } from "@/components/FilterParts";
import { FILTER_CLEAR, FILTER_TRIGGER, FILTER_TRIGGER_ON, NO_VALUE, filterCount } from "@/lib/filter-parts";
import { cn } from "@/lib/utils";
import { useThreadsListStore } from "@/store/threads-list";
import { labelChoices, projectChoices, type ListedThread } from "./thread-list";

const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What a group's menu lists: the values the tab's threads carry, and any
 *  ticked one they do not (ticked on the other tab), so it can be unticked;
 *  then No label / No project, under Select all. */
function useChoices(threads: readonly ListedThread[]) {
  const filters = useThreadsListStore((s) => s.filters);
  const store = useThreadsListStore.getState;
  const carried = { labels: labelChoices(threads), projects: projectChoices(threads) };
  const names = (list: string[], none: string) => [
    ...list.filter((name) => name !== NO_VALUE).sort((a, b) => a.localeCompare(b)).map((name) => ({ id: name, label: name })),
    { id: NO_VALUE, label: none }
  ];
  const label: FilterChoicesProps = {
    choices: names([...carried.labels, ...filters.labels.filter((ticked) => !carried.labels.some((name) => sameLabel(name, ticked)))], "No label"),
    ticked: (name) => filters.labels.some((ticked) => sameLabel(ticked, name)),
    onToggle: (name) => store().toggleLabel(name),
    onTickOnly: (list) => store().setLabels(list)
  };
  const project: FilterChoicesProps = {
    choices: names([...carried.projects, ...filters.projects.filter((ticked) => !carried.projects.includes(ticked))], "No project"),
    ticked: (name) => filters.projects.includes(name),
    onToggle: (name) => store().toggleProject(name),
    onTickOnly: (list) => store().setProjects(list)
  };
  return { filters, label, project };
}

/** Clear filters, as the bar, the sheet and the empty list say it. */
export function ClearThreadFilters({ className }: { className?: string }) {
  return (
    <button type="button" className={cn(FILTER_CLEAR, className)} onClick={() => useThreadsListStore.getState().clearFilters()}>
      Clear filters
    </button>
  );
}

/** The Threads page's filter bar on a desktop: Label and Project, each a
 *  menu of checkboxes over what the tab's threads carry; Clear filters
 *  while any is ticked. */
export function ThreadFilterBar({ threads }: { threads: readonly ListedThread[] }) {
  const { filters, label, project } = useChoices(threads);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-slot="thread-filter-label" className={cn(FILTER_TRIGGER, filters.labels.length > 0 && FILTER_TRIGGER_ON)}>
            {filterCount("Label", filters.labels.length)}<ChevronDown aria-hidden className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-44 overflow-y-auto">
          <FilterMenuChoices {...label} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-slot="thread-filter-project" className={cn(FILTER_TRIGGER, filters.projects.length > 0 && FILTER_TRIGGER_ON)}>
            {filterCount("Project", filters.projects.length)}<ChevronDown aria-hidden className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-44 overflow-y-auto">
          <FilterMenuChoices {...project} />
        </DropdownMenuContent>
      </DropdownMenu>
      {(filters.labels.length > 0 || filters.projects.length > 0) && <ClearThreadFilters />}
    </>
  );
}

/** A phone's one Filter button, with how many are ticked; it opens the same
 *  two groups in a sheet. */
export function ThreadFilterPhone({ threads }: { threads: readonly ListedThread[] }) {
  const { filters, label, project } = useChoices(threads);
  const [open, setOpen] = useState(false);
  const total = filters.labels.length + filters.projects.length;
  return (
    <>
      <button type="button" data-slot="thread-filter-phone" onClick={() => setOpen(true)} className={cn(FILTER_TRIGGER, "hit relative h-9 px-3", total > 0 && FILTER_TRIGGER_ON)}>
        <SlidersHorizontal aria-hidden className="size-3.5" />{filterCount("Filter", total)}
      </button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        slot="thread-filter-sheet"
        bodyClassName="flex flex-col gap-1 px-2 pb-4"
        header={<div className="flex h-8 items-center px-4"><BottomSheetTitle className="text-sm font-semibold">Filter threads</BottomSheetTitle></div>}
      >
        <FilterSheetGroup first>Label</FilterSheetGroup>
        <FilterSheetChoices {...label} />
        <FilterSheetGroup>Project</FilterSheetGroup>
        <FilterSheetChoices {...project} />
        {total > 0 && <ClearThreadFilters className="mx-3 mt-2 self-start py-2" />}
      </BottomSheet>
    </>
  );
}
