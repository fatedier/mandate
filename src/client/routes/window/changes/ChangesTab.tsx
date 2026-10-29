import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "@shared/api-contracts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useElementWidth } from "@/hooks/useElementWidth";
import { cn } from "@/lib/utils";
import { ChangedFileDetail } from "./ChangedFileDetail";
import { RefreshButton } from "@/components/RefreshButton";
import { useChanges } from "./useChanges";
import { usePlanStamp } from "./use-plan-stamp";
import { changesLayout, type ChangesLayout } from "./changes-layout";
import { splitFileName } from "./file-name";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { revealRow, useChangesScroll } from "./useChangesScroll";

const STATUS_CLASS: Record<FeatureChangedFileDto["status"], string> = {
  A: "text-diff-add-fg",
  M: "text-amber",
  D: "text-diff-del-fg",
  R: "text-faint"
};

function FileListItem({
  file,
  selected,
  drillIn,
  onSelect
}: {
  file: FeatureChangedFileDto;
  selected: boolean;
  /** The row opens a whole screen (drilled in: a phone, or a panel too narrow
   *  for a list beside a diff) rather than selecting within a master-detail
   *  that already shows the diff. Two things follow, which is why this is one
   *  flag and not two:
   *
   *  - **Counts.** Drilled in, the list is all you have before spending a screen
   *    on a file, so it has to say how big the change is. The desktop sidebar
   *    has the diff right beside it and never needed the number — and at 240px
   *    the counts eat 40-66px per row, collapsing the directory hint, which is
   *    the only thing distinguishing two files with the same basename.
   *  - **Chevron.** A full-width row with no affordance reads as a static
   *    summary line. The chevron is what says it opens something. The desktop
   *    row is visibly a selection (`aria-current`, a filled background) against
   *    a diff that changes beside it, so it needs no such hint. */
  drillIn: boolean;
  onSelect: () => void;
}) {
  const { base, head, tail, dir } = splitFileName(file.path);
  return (
    <button
      type="button"
      id={`change-${file.path}`}
      onClick={onSelect}
      title={file.path}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-center gap-1.5 rounded-sm px-2 py-1 pointer-coarse:min-h-11 text-left text-xs ${
        selected ? "bg-surface-2 text-foreground" : "text-soft hover:bg-surface-2"
      }`}
    >
      <span className={`w-3 shrink-0 font-mono font-bold ${STATUS_CLASS[file.status]}`}>
        {file.status}
      </span>
      {/* One line, the name first. A long name is cut in the middle and keeps
          its end. The directory takes the room left, down to four characters
          (its basis): with less it wraps to the second line, which the
          one-line height hides, rather than show a sliver of a letter. */}
      <span data-slot="file-name" className="flex h-[1lh] min-w-0 flex-1 flex-wrap items-baseline gap-x-1 overflow-hidden">
        {/* Split, the two halves are flex items, which a screen reader reads
            as two words: it gets the name whole instead. The kept end never
            shrinks, but is capped to leave the head room for its ellipsis: an
            end wider than the row (wide characters) is cut too, with its own. */}
        <span className="flex min-w-0 font-mono" aria-hidden={tail ? true : undefined}>
          <span data-slot="file-name-head" className="min-w-0 truncate">{head}</span>
          {tail ? <span data-slot="file-name-tail" className="max-w-[calc(100%-1.5ch)] shrink-0 truncate">{tail}</span> : null}
        </span>
        {tail ? <span className="sr-only">{base}</span> : null}
        {dir ? <span data-slot="file-dir" className="min-w-0 grow basis-[4ch] truncate text-faint">{dir}</span> : null}
      </span>
      {/* Rendered only when it has something in it. The row is `flex gap-1.5`,
          so an always-present empty wrapper would still cost a 6px gap and
          steal that width from the directory hint — measured: it shortened the
          desktop hint from 53.3px to 47.3px on rows with no uncommitted dot. */}
      {drillIn || file.uncommitted ? (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {drillIn ? (
            file.binary ? (
              <span className="label-micro text-faint">binary</span>
            ) : (
              <span className="label-micro tabular-nums">
                {file.additions !== null ? <span className="text-diff-add-fg">+{file.additions}</span> : null}
                {file.deletions !== null ? <span className="text-diff-del-fg"> −{file.deletions}</span> : null}
              </span>
            )
          ) : null}
          {file.uncommitted ? (
            <span
              aria-label="uncommitted"
              title="Has uncommitted changes"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber"
            />
          ) : null}
          {/* `aria-hidden`: the button already announces the file and its role.
              A chevron read out as "chevron right" would be noise. */}
          {drillIn ? <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-faint" /> : null}
        </span>
      ) : null}
    </button>
  );
}

type CompareMode = FeatureChangesResponse["compare"];

/**
 * Two segments, not a dropdown: there are exactly two answers and both fit.
 * Labels name what you get rather than how it is computed — "Uncommitted" is
 * what the reader is looking for, "Since base" is the review question.
 */
function CompareToggle({
  value,
  onChange
}: {
  value: CompareMode;
  onChange: (next: CompareMode) => void;
}) {
  return (
    // Each label stays whole; in a very narrow tab the two buttons stack, and
    // on touch their 44px areas (12px past each ~20px button) need 24px.
    <div role="group" aria-label="Compare against" className="flex flex-wrap items-center gap-0.5 pointer-coarse:gap-y-6">
      {([["head", "Uncommitted"], ["branch", "Since base"]] as const).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          aria-pressed={value === mode}
          className={cn(
            "hit relative whitespace-nowrap rounded px-2 py-0.5 text-2xs transition-colors",
            value === mode
              ? "bg-sel text-foreground"
              : "text-chrome hover:text-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Laid out by its own width, not by the device: the thread page's worker
 *  panel at a 1440 half split is 603px, where a list beside a split diff left
 *  16 characters a side. Measured here, around every state, so the width is
 *  known before the list arrives and the first render of it is already right. */
export function ChangesTab(props: {
  featureId: string;
  initialFile: string | null;
  /** A worker with no branch of its own has no base to compare against: only
   *  what is uncommitted is shown, and nothing asks which. */
  uncommittedOnly?: boolean;
}) {
  const isMobile = useIsMobile();
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const layout = useSettledLayout(width, isMobile);
  return (
    <div ref={measure} data-slot="changes-tab" data-layout={layout.drillIn ? "drill-in" : layout.split ? "split" : "unified"}>
      <ChangesTabContent {...props} layout={layout} />
    </div>
  );
}

/** `changesLayout` given the layout of the render before, so it settles
 *  rather than flipping on the scrollbar its own height brings and takes. */
function useSettledLayout(width: number, isMobile: boolean): ChangesLayout {
  const [settled, setSettled] = useState(() => ({ width, isMobile, layout: changesLayout(width, isMobile) }));
  if (settled.width === width && settled.isMobile === isMobile) return settled.layout;
  const layout = changesLayout(width, isMobile, settled.layout);
  setSettled({ width, isMobile, layout });
  return layout;
}

function ChangesTabContent({
  featureId,
  initialFile,
  uncommittedOnly = false,
  layout
}: {
  featureId: string;
  initialFile: string | null;
  uncommittedOnly?: boolean;
  layout: ChangesLayout;
}) {
  const [selected, setSelected] = useState<string | null>(initialFile);
  // Uncommitted by default. The branch comparison needs a base ref, and a base
  // ref goes stale: it then lists far more files than the work touched, and
  // fails outright on a branch orphaned by a history rewrite. What is being
  // changed right now cannot be wrong.
  const [compare, setCompare] = useState<CompareMode>("head");
  const { drillIn, split } = layout;
  const toggle = uncommittedOnly ? null : <CompareToggle value={compare} onChange={setCompare} />;

  const planStamp = usePlanStamp(featureId);
  const { view, load } = useChanges(featureId, compare, planStamp);
  const data = view?.data;

  const fileViewRef = useChangesScroll({ initialFile, data, drillIn, selected });

  if (view?.error) {
    return (
      <div className="flex flex-col gap-3 py-4">
        {toggle}
        <InlineError detail={view.error} onRetry={() => void load()}>
          {view.errorCode === "worktree_missing"
            ? "This worker's worktree folder is missing, so there are no changes to show."
            : "Couldn't load changes."}
        </InlineError>
      </div>
    );
  }
  if (!data || !view?.diffs) return (
    <div className="flex flex-col gap-3 py-4">
      {toggle}
      <LoadingLine />
    </div>
  );

  // Derived, not stored: a stale selection (file dropped by a refetch, or a
  // dead deep link) falls back to the first file beside the list, which always
  // shows a diff. Drilled in it falls back to *nothing* and the list comes
  // back — showing a different file's diff under the header you just tapped is
  // worse than going back a step.
  const selectedFile =
    data.files.find((f) => f.path === selected) ?? (drillIn ? null : data.files[0] ?? null);

  const index = selectedFile ? data.files.findIndex((f) => f.path === selectedFile.path) : -1;
  const prevFile = index > 0 ? data.files[index - 1]! : null;
  const nextFile = index >= 0 && index < data.files.length - 1 ? data.files[index + 1]! : null;

  const backToList = () => {
    const path = selectedFile?.path;
    setSelected(null);
    // Reuse the deep-link scroll mechanism so returning lands on the row you
    // were just reading rather than at the top of a long list.
    if (path) window.setTimeout(() => revealRow(path), 0);
  };

  return (
    <div className="flex flex-col gap-3 py-4">
      <ChangesToolbar
        data={data}
        toggle={toggle}
        refreshing={view.refreshing}
        onRefresh={() => void load()}
      />
      {data.files.length === 0 ? (
        <p className="text-sm text-faint">
          {data.compare === "head"
            ? "Nothing uncommitted."
            : `No changes against ${data.baseRef}.`}
        </p>
      ) : drillIn ? (
        selectedFile ? (
          // Brought to the top of its scroller below the worker's pinned
          // tabs, not under them.
          <div ref={fileViewRef} className="flex min-h-dvh scroll-mt-[var(--worker-pinned,0px)] flex-col gap-3">
            <DrilledInFileBar
              path={selectedFile.path}
              position={index + 1}
              total={data.files.length}
              prev={prevFile?.path ?? null}
              next={nextFile?.path ?? null}
              onBack={backToList}
              onOpen={setSelected}
            />
            <section aria-label="File diff" className="min-w-0">
              <ChangedFileDetail
                key={`${view.revision}:${selectedFile.path}`}
                cache={view.diffs}
                file={selectedFile}
                unified
              />
            </section>
          </div>
        ) : (
          // `<nav>`, not a bare `<div>`: an `aria-label` on a `div` lands on
          // role `generic`, which assistive tech drops entirely — the label
          // would simply not exist. Drilled in, this list *is* the navigation
          // between files, so `nav` is also the truer role; the `<aside>` below
          // is a complement to a diff that is already on screen.
          <nav className="flex flex-col gap-px" aria-label="Changed files">
            {data.files.map((f) => (
              <FileListItem
                key={f.path}
                file={f}
                selected={false}
                drillIn
                onSelect={() => setSelected(f.path)}
              />
            ))}
          </nav>
        )
      ) : (
        <div className="flex items-start gap-4">
          <aside
            aria-label="Changed files"
            // 16px under the worker's pinned tabs, and as much shorter.
            className="sticky top-[calc(var(--worker-pinned,0px)+1rem)] flex max-h-[calc(100vh-7rem-var(--worker-pinned,0px))] w-60 shrink-0 flex-col gap-px overflow-y-auto"
          >
            {data.files.map((f) => (
              <FileListItem
                key={f.path}
                file={f}
                selected={f.path === selectedFile?.path}
                drillIn={false}
                onSelect={() => setSelected(f.path)}
              />
            ))}
          </aside>
          <section aria-label="File diff" className="min-w-0 flex-1">
            {selectedFile ? (
              <ChangedFileDetail
                key={`${view.revision}:${selectedFile.path}`}
                cache={view.diffs}
                file={selectedFile}
                unified={!split}
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

/** Count, totals, what they are compared against, and Refresh. `toggle` is
 *  the choice of comparison, null where there is none to make. */
function ChangesToolbar({ data, toggle, refreshing, onRefresh }: {
  data: FeatureChangesResponse;
  toggle: ReactNode;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    // Each item keeps to one line and the row wraps between them: a narrow
    // panel puts count and totals over the toggle, never "21 / files".
    <div data-slot="changes-toolbar" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="min-w-0 max-w-full truncate text-faint" title={data.compare === "branch" ? `vs ${data.baseRef}` : undefined}>
        {data.files.length} file{data.files.length === 1 ? "" : "s"}
        {data.compare === "branch" && (
          <>
            {" "}vs <span className="font-mono">{data.baseRef}</span>
          </>
        )}
      </span>
      <span className="whitespace-nowrap">
        <span className="text-diff-add-fg">+{data.totalAdditions}</span>{" "}
        <span className="text-diff-del-fg">−{data.totalDeletions}</span>
      </span>
      {/* Toggle and Refresh wrap as one: a row of their own, Refresh still
          at the far end, rather than the icon alone on a line. Sized by its
          content to decide the wrap; narrower still, the toggle stacks. */}
      <div className="flex grow items-center gap-3">
        {toggle}
        <RefreshButton scope="local" what="changes" refreshing={refreshing} onRefresh={onRefresh} className="ml-auto" />
      </div>
    </div>
  );
}

/** Drilled into one file: back to the list, its name, where it is in the
 *  list, and the files before and after it. */
function DrilledInFileBar({ path, position, total, prev, next, onBack, onOpen }: {
  path: string;
  position: number;
  total: number;
  prev: string | null;
  next: string | null;
  onBack: () => void;
  onOpen: (path: string) => void;
}) {
  return (
    // No vertical padding: the 44px touch targets set the bar's height. Every
    // control here is a tap target on a phone (the same bar serves a narrow
    // panel), so each one carries `h-11` (44px) rather than relying on the
    // text box — `text-sm` alone gives a 21px-tall hit area, which is far
    // under any usable minimum for a thumb. The glyphs are unchanged; only
    // the box around them grew.
    // Pinned right under the worker's tabs.
    <div className="sticky top-[var(--worker-pinned,0px)] z-10 flex items-center gap-2 border-b border-border-soft bg-background">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to changed files"
        className="flex h-11 shrink-0 items-center text-sm text-muted-foreground"
      >
        ← Files
      </button>
      <span className="min-w-0 truncate font-mono text-xs" title={path}>
        {path.slice(path.lastIndexOf("/") + 1)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span className="label-micro tabular-nums text-faint">
          {position}/{total}
        </span>
        <button
          type="button"
          aria-label="Previous file"
          disabled={!prev}
          onClick={() => prev && onOpen(prev)}
          className="flex h-11 w-11 items-center justify-center text-sm disabled:text-faint disabled:opacity-40"
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Next file"
          disabled={!next}
          onClick={() => next && onOpen(next)}
          className="flex h-11 w-11 items-center justify-center text-sm disabled:text-faint disabled:opacity-40"
        >
          ›
        </button>
      </span>
    </div>
  );
}
