import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "@shared/api-contracts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import { useWorkItemsStore } from "@/store/work-items";
import { ChangedFileDetail } from "./ChangedFileDetail";
import { RefreshButton } from "@/components/RefreshButton";
import { useChanges } from "./useChanges";

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
  /** The row opens a whole screen (mobile) rather than selecting within a
   *  master-detail that already shows the diff (desktop). Two things follow,
   *  which is why this is one flag and not two:
   *
   *  - **Counts.** On a phone the list is all you have before spending a screen
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
  const slash = file.path.lastIndexOf("/");
  const base = slash === -1 ? file.path : file.path.slice(slash + 1);
  const dir = slash === -1 ? null : file.path.slice(0, slash);
  return (
    <button
      type="button"
      id={`change-${file.path}`}
      onClick={onSelect}
      title={file.path}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs ${
        selected ? "bg-surface-2 text-foreground" : "text-soft hover:bg-surface-2"
      }`}
    >
      <span className={`w-3 shrink-0 font-mono font-bold ${STATUS_CLASS[file.status]}`}>
        {file.status}
      </span>
      <span className="flex min-w-0 items-baseline gap-1 overflow-hidden">
        <span className="shrink-0 font-mono">{base}</span>
        {dir ? <span className="truncate text-faint">{dir}</span> : null}
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
    <div role="group" aria-label="Compare against" className="flex items-center gap-0.5">
      {([["head", "Uncommitted"], ["branch", "Since base"]] as const).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          aria-pressed={value === mode}
          className={cn(
            "rounded px-2 py-0.5 text-2xs transition-colors",
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

export function ChangesTab({
  featureId,
  initialFile
}: {
  featureId: string;
  initialFile: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(initialFile);
  // Uncommitted by default. The branch comparison needs a base ref, and a base
  // ref goes stale: on this store it showed 258 files where the work was 16,
  // 127 where it was 7, and failed outright on a branch orphaned by a history
  // rewrite. What is being changed right now cannot be wrong.
  const [compare, setCompare] = useState<CompareMode>("head");
  const isMobile = useIsMobile();

  const workItemStamp = useWorkItemsStore((s) => {
    for (const item of s.items.values()) {
      if (item.featureId === featureId) return `${item.phase}:${item.needsUser ?? ""}`;
    }
    return "";
  });
  const { view, load } = useChanges(featureId, compare, workItemStamp);
  const data = view?.data;

  // Scroll the deep-linked file's list row into view once per initialFile
  // value: the effect depends on `data` (the row exists only after load), so
  // without the guard every refetch would yank the list back to it.
  const hasScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialFile || !data) return;
    if (hasScrolledRef.current === initialFile) return;
    const timer = window.setTimeout(() => {
      hasScrolledRef.current = initialFile;
      document.getElementById(`change-${initialFile}`)?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialFile, data]);

  if (view?.error) {
    return (
      <div className="flex flex-col gap-2 py-6 text-sm">
        <CompareToggle value={compare} onChange={setCompare} />
        <p className="text-destructive">{view.error}</p>
        <button type="button" onClick={() => void load()} className="self-start text-foreground underline decoration-border underline-offset-[3px]">
          Retry
        </button>
      </div>
    );
  }
  if (!data || !view?.diffs) return (
    <div className="flex flex-col gap-3 py-4">
      <CompareToggle value={compare} onChange={setCompare} />
      <p className="py-6 text-sm text-faint">Loading changes…</p>
    </div>
  );

  // Derived, not stored: a stale selection (file dropped by a refetch, or a
  // dead deep link) falls back to the first file on desktop, which always shows
  // a diff. On mobile it falls back to *nothing* and the list comes back —
  // showing a different file's diff under the header you just tapped is worse
  // than going back a step.
  const selectedFile =
    data.files.find((f) => f.path === selected) ?? (isMobile ? null : data.files[0] ?? null);

  const index = selectedFile ? data.files.findIndex((f) => f.path === selectedFile.path) : -1;
  const prevFile = index > 0 ? data.files[index - 1]! : null;
  const nextFile = index >= 0 && index < data.files.length - 1 ? data.files[index + 1]! : null;

  const backToList = () => {
    const path = selectedFile?.path;
    setSelected(null);
    // Reuse the deep-link scroll mechanism so returning lands on the row you
    // were just reading rather than at the top of a long list.
    if (path) {
      window.setTimeout(() => {
        document.getElementById(`change-${path}`)?.scrollIntoView({ block: "nearest" });
      }, 0);
    }
  };

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-center gap-3 text-sm">
        <span className="text-faint">
          {data.files.length} file{data.files.length === 1 ? "" : "s"}
          {data.compare === "branch" && (
            <>
              {" "}vs <span className="font-mono">{data.baseRef}</span>
            </>
          )}
        </span>
        <span>
          <span className="text-diff-add-fg">+{data.totalAdditions}</span>{" "}
          <span className="text-diff-del-fg">−{data.totalDeletions}</span>
        </span>
        <CompareToggle value={compare} onChange={setCompare} />
        <RefreshButton scope="local" what="changes" refreshing={view.refreshing} onRefresh={() => void load()} className="ml-auto" />
      </div>
      {data.files.length === 0 ? (
        <p className="text-sm text-faint">
          {data.compare === "head"
            ? "Nothing uncommitted."
            : `No changes against ${data.baseRef}.`}
        </p>
      ) : isMobile ? (
        selectedFile ? (
          <div className="flex flex-col gap-3">
            {/* No vertical padding: the 44px touch targets set the bar's
                height. Every control here is a phone-only tap target, so each
                one carries `h-11` (44px) rather than relying on the text box —
                `text-sm` alone gives a 21px-tall hit area, which is far under
                any usable minimum for a thumb. The glyphs are unchanged; only
                the box around them grew. */}
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-soft bg-background">
              <button
                type="button"
                onClick={backToList}
                aria-label="Back to changed files"
                className="flex h-11 shrink-0 items-center text-sm text-muted-foreground"
              >
                ← Files
              </button>
              <span className="min-w-0 truncate font-mono text-xs" title={selectedFile.path}>
                {selectedFile.path.slice(selectedFile.path.lastIndexOf("/") + 1)}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <span className="label-micro tabular-nums text-faint">
                  {index + 1}/{data.files.length}
                </span>
                <button
                  type="button"
                  aria-label="Previous file"
                  disabled={!prevFile}
                  onClick={() => prevFile && setSelected(prevFile.path)}
                  className="flex h-11 w-11 items-center justify-center text-sm disabled:text-faint disabled:opacity-40"
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="Next file"
                  disabled={!nextFile}
                  onClick={() => nextFile && setSelected(nextFile.path)}
                  className="flex h-11 w-11 items-center justify-center text-sm disabled:text-faint disabled:opacity-40"
                >
                  ›
                </button>
              </span>
            </div>
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
          // would simply not exist. On mobile this list *is* the navigation
          // between files, so `nav` is also the truer role; the desktop
          // `<aside>` below is a complement to a diff that is already on screen.
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
            className="sticky top-4 flex max-h-[calc(100vh-7rem)] w-60 shrink-0 flex-col gap-px overflow-y-auto"
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
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
