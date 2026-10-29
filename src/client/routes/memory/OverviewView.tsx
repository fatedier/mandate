import { useState, type ReactNode } from "react";
import { ChevronRight, Play } from "lucide-react";
import { Link } from "react-router";
import type { MemoryBriefDto, MemoryDreamRunDto, MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { Section, SectionLink, SectionRow } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/ViewState";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatDreamDuration, type DreamBatch } from "./dream/memory-run-model";
import { DreamPartitionPill } from "./dream/shared";
import { partitionTally } from "./dream/helpers";
import { useRunDialog } from "./dream/use-run-dialog";
import { BriefsSection } from "./BriefsSection";
import { MemoryDetailDialog } from "./MemoryEntryDetail";
import { browseHref } from "./memory-filters";
import { entryFacets, previewText, projectNameResolver } from "./memory-entry";

/**
 * The landing view: what state the store is in, and a way into whatever you
 * want to do about it.
 *
 * Every section is a doorway. That is the whole design — Overview deliberately
 * lists nothing at length, because the moment it grows a scrolling list it has
 * become Browse with worse filters. If something here needs more than a few
 * rows to say, it belongs behind one of these links.
 */
export function OverviewView({
  stats,
  briefs = null,
  justLearned,
  lastDream,
  loading,
  onRunDream,
  running,
  error = null,
  onRetry
}: {
  stats: MemoryStatsResponse | null;
  /** The briefs; null until they are read. */
  briefs?: MemoryBriefDto[] | null;
  justLearned: MemoryEntryDto[];
  lastDream: DreamBatch | null;
  loading: boolean;
  onRunDream: () => void;
  running: boolean;
  /** Why the last read failed, until one succeeds. */
  error?: string | null;
  onRetry?: () => void;
}) {
  const [openEntry, setOpenEntry] = useState<MemoryEntryDto | null>(null);
  if (!stats) {
    if (loading) return <OverviewSkeleton />;
    return error ? <InlineError detail={error} onRetry={onRetry}>Couldn't load memory.</InlineError> : null;
  }

  const resolveProject = projectNameResolver(stats);
  const collisions = duplicateProjectNames(stats);

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <InlineError detail={error} onRetry={onRetry}>
          Couldn't refresh memory. Showing the last loaded figures.
        </InlineError>
      )}
      {briefs && <BriefsSection briefs={briefs} stats={stats} />}

      {collisions.length > 0 && (
        <Section title="Project names">
          {collisions.map((collision) => (
            <NameCollisionRow key={collision.name} collision={collision} />
          ))}
        </Section>
      )}

      {/* `grid-cols-1` spelled out: the implicit single track is `auto`, which
          sized to the widest line inside and pushed the page to 6,777px on a
          phone. An explicit 1fr track is bounded by the column. */}
      <div className="grid grid-cols-1 items-start gap-6 @min-[52rem]:grid-cols-2">
        <MemoriesSection stats={stats} />
        <LastDreamSection lastDream={lastDream} running={running} onRunDream={onRunDream} resolveProject={resolveProject} />
      </div>

      <Section
        title="Just learned"
        meta="newest first"
        trailing={<SectionLink to="/memory?view=activity">Full activity</SectionLink>}
      >
        {justLearned.length === 0 ? (
          <EmptyRow>Nothing learned yet.</EmptyRow>
        ) : (
          justLearned.map((entry) => (
            <SectionRow key={entry.id} minH="52" className="items-start p-0">
              <button
                type="button"
                onClick={() => setOpenEntry(entry)}
                className="flex min-h-13 min-w-0 flex-1 items-start gap-3 self-stretch px-3.5 py-2.5 text-left transition-colors hover:bg-sel"
              >
                <span className="num font-mono w-[52px] shrink-0 pt-0.5 text-2xs text-faint">
                  {formatRelativeTime(entry.createdAt)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-2xs text-chrome">{entryFacets(entry, resolveProject)}</span>
                  <span data-slot="memory-preview" className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-foreground">
                    {previewText(entry.content)}
                  </span>
                </span>
              </button>
            </SectionRow>
          ))
        )}
      </Section>
      <MemoryDetailDialog
        entry={openEntry}
        open={openEntry !== null}
        onOpenChange={(open) => !open && setOpenEntry(null)}
        resolveProject={resolveProject}
      />
    </div>
  );
}

/** One quiet row for a section with nothing to list. */
function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <SectionRow>
      <span className="text-2xs text-faint">{children}</span>
    </SectionRow>
  );
}


/**
 * Names carried by more than one project, with the projects themselves.
 *
 * The projects and not just the count, because the id is the only thing that
 * differs and the row's whole job is to lead somewhere the two come apart.
 * `byProject` counts available memories only, so an archived project cannot
 * appear here — its memories were archived with it — and a name shared with a
 * dead project is not a collision anyone can act on.
 */
interface NameCollision {
  name: string;
  projects: MemoryStatsResponse["byProject"];
}

function duplicateProjectNames(stats: MemoryStatsResponse): NameCollision[] {
  const seen = new Map<string, MemoryStatsResponse["byProject"]>();
  for (const project of stats.byProject) {
    const group = seen.get(project.name);
    if (group) group.push(project);
    else seen.set(project.name, [project]);
  }
  return [...seen.entries()]
    .filter(([, projects]) => projects.length > 1)
    .map(([name, projects]) => ({ name, projects }));
}

function BandKey({
  tone,
  value,
  label,
  href
}: {
  tone: string;
  value: number;
  label: string;
  href: string;
}) {
  return (
    <Link
      to={href}
      className="hit relative inline-flex items-center gap-1.5 text-faint transition-colors hover:text-foreground"
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} />
      <span className="num text-foreground">{value}</span>
      <span>{label}</span>
    </Link>
  );
}

/**
 * One name, and a way into each project holding it.
 *
 * The count is the real one. It used to be the literal `2` beside the word
 * "both", which read as a sentence only because the badge supplied its first
 * word, and told a three-way collision it was a pair.
 *
 * One door per project rather than one saying "tell them apart": the previous
 * link went to Browse filtered to every project-scoped memory, where each row
 * prints `entryLocation` — the project *name* — so the two arrived
 * indistinguishable, which is what the reader came to resolve. Filtering by
 * `projectId` is what actually separates them, and the memory counts are the
 * one visible difference between two projects that share everything else.
 */
function NameCollisionRow({ collision }: { collision: NameCollision }) {
  return (
    <Attention
      count={collision.projects.length}
      text={
        <>
          projects share the name{" "}
          <code className="font-mono text-foreground">{collision.name}</code>
        </>
      }
      doors={collision.projects.map((project) => ({
        key: project.projectId,
        label: `${project.count} ${project.count === 1 ? "memory" : "memories"}`,
        href: browseHref({ projectId: project.projectId })
      }))}
    />
  );
}

function Attention({
  count,
  text,
  doors
}: {
  count: number;
  text: ReactNode;
  /** One or more ways out. A row with several is why this is a list rather
   *  than the single label-and-href it started as. */
  doors: Array<{ key: string; label: string; href: string }>;
}) {
  return (
    <SectionRow minH="44" className="items-start py-2.5">
      {/* The count is the sentence's first word — "2" then "projects share
          the name project-3" — so it sits on the text's first line, not centred
          against the doors below. */}
      <span className="num w-7 shrink-0 text-xs font-semibold">{count}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{text}</div>
        <div className="flex flex-wrap items-center gap-x-3">
          {doors.map((door) => (
            // On a touch screen each link is a 44px line of its own: wrapped
            // lines sit edge to edge, and the panel clips the last.
            <Link
              key={door.key}
              to={door.href}
              className="hit relative text-2xs text-foreground underline decoration-border underline-offset-[3px] pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {door.label}
            </Link>
          ))}
        </div>
      </div>
    </SectionRow>
  );
}

/** The store's size: what kinds of memory it holds, and where. */
function MemoriesSection({ stats }: { stats: MemoryStatsResponse }) {
  const { available, archived, total } = stats.totals;
  const projects = stats.byProject.filter((project) => project.count > 0).length;
  return (
    <Section title="Memories" meta={`${available} live · ${archived} archived · ${total} ever learned`}>
      {/* Wrapped on a narrow phone, the keys' 44px touch areas need 28px
          between their 16px lines, and 14px inside the panel's edge. */}
      <div className="flex flex-col gap-2 px-3.5 py-3.5 pointer-coarse:gap-7 text-2xs">
        <KeyLine label="By type">
          <BandKey tone="bg-faint/60" value={stats.byType.preference} label="preferences" href={browseHref({ type: "preference" })} />
          <BandKey tone="bg-faint/60" value={stats.byType.knowledge} label="knowledge" href={browseHref({ type: "knowledge" })} />
        </KeyLine>
        <KeyLine label="By scope">
          <BandKey tone="bg-faint/60" value={stats.byScope.user} label="yours" href={browseHref({ scope: "user" })} />
          <BandKey
            tone="bg-faint/60"
            value={stats.byScope.project}
            label={`in ${projects} ${projects === 1 ? "project" : "projects"}`}
            href={browseHref({ scope: "project" })}
          />
        </KeyLine>
      </div>
    </Section>
  );
}

function KeyLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pointer-coarse:gap-y-7">
      <span className="w-14 shrink-0 text-chrome">{label}</span>
      {children}
    </div>
  );
}

/** The last maintenance pass, or the one running now: one row per partition,
 *  each opening that partition's run, and a way to start one. */
function LastDreamSection({ lastDream, running, onRunDream, resolveProject }: {
  lastDream: DreamBatch | null;
  running: boolean;
  onRunDream: () => void;
  resolveProject: (projectId: string) => string | undefined;
}) {
  const runDialog = useRunDialog(resolveProject);
  const dreamActive = running || Boolean(lastDream?.running);
  const duration = lastDream ? formatDreamDuration(lastDream.startedAt, lastDream.finishedAt) : "";
  return (
    <Section
      title={lastDream?.running ? "Dreaming now" : "Last dream"}
      meta={lastDream ? [formatRelativeTime(lastDream.startedAt), duration].filter(Boolean).join(" · ") : undefined}
      trailing={
        <Button variant="outline" size="xs" disabled={dreamActive} onClick={onRunDream}>
          <Play className="size-3" />
          {dreamActive ? "Running…" : "Run now"}
        </Button>
      }
    >
      {lastDream ? (
        lastDream.runs.map((run) => <PartitionRow key={run.id} run={run} onOpen={() => void runDialog.openRun(run)} />)
      ) : (
        <EmptyRow>No maintenance has run yet.</EmptyRow>
      )}
      {runDialog.error && <EmptyRow>{runDialog.error}</EmptyRow>}
      {runDialog.dialog}
    </Section>
  );
}

function PartitionRow({ run, onOpen }: { run: MemoryDreamRunDto; onOpen: () => void }) {
  const took = formatDreamDuration(run.startedAt, run.finishedAt);
  return (
    <SectionRow className="p-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-3 self-stretch px-3.5 py-1.5 text-left transition-colors hover:bg-sel"
      >
        {/* On a narrow phone the name gives way before the tally does. */}
        <DreamPartitionPill run={run} className="min-w-0 shrink" />
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          {/* Motion means real activity: a run in flight is exactly that. */}
          {run.status === "running" && (
            <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full bg-live animate-live" />
          )}
          <span className="truncate">{partitionTally(run)}</span>
        </span>
        {took && <span data-slot="run-took" className="num shrink-0 text-2xs text-faint @max-[24rem]:hidden">took {took}</span>}
        <ChevronRight aria-hidden className="size-3 shrink-0 text-chrome" />
      </button>
    </SectionRow>
  );
}

/** Header lines + panels in --sel: the shape the loaded view will have. */
function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Section title={<Skeleton className="h-3 w-16 rounded-xs bg-sel" />}>
        <div className="flex flex-col gap-3 p-3.5">
          <Skeleton className="h-2 w-full rounded-full bg-sel" />
          <Skeleton className="h-3 w-64 rounded-xs bg-sel" />
        </div>
      </Section>
      <Section title={<Skeleton className="h-3 w-32 rounded-xs bg-sel" />}>
        <div className="flex flex-col gap-3 p-3.5">
          <Skeleton className="h-3.5 w-[90%] rounded-xs bg-sel" />
          <Skeleton className="h-3.5 w-[70%] rounded-xs bg-sel" />
          <Skeleton className="h-3.5 w-[55%] rounded-xs bg-sel" />
        </div>
      </Section>
    </div>
  );
}
