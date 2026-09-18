import { type ReactNode } from "react";
import { Play } from "lucide-react";
import { Link } from "react-router";
import type { MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { Section, SectionLink, SectionRow } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatDreamDuration, type DreamBatch } from "./dream/memory-run-model";
import { browseHref } from "./memory-filters";
import { entryFacets } from "./memory-entry";

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
  topRecalled,
  justLearned,
  lastDream,
  loading,
  onRunDream,
  running
}: {
  stats: MemoryStatsResponse | null;
  topRecalled: MemoryEntryDto[];
  justLearned: MemoryEntryDto[];
  lastDream: DreamBatch | null;
  loading: boolean;
  onRunDream: () => void;
  running: boolean;
}) {
  if (!stats) return loading ? <OverviewSkeleton /> : null;

  const { available, archived, total } = stats.totals;
  // A server older than the usage bands omits the field. Show nothing rather
  // than zeros: "143 live" beside "0 used, 0 recalled, 0 never recalled" is a
  // self-contradiction, and a reader has no way to tell an empty store from an
  // absent field. The totals still stand on their own.
  const usage = stats.usage ?? null;
  // The headline figure is the gap, not the total. Nearly everything gets
  // recalled eventually; what distinguishes a memory is whether it was ever
  // leaned on once it arrived.
  const idlePct = usage && available > 0 ? Math.round((usage.idle / available) * 100) : null;
  const collisions = duplicateProjectNames(stats);
  const changedCount = lastDream ? dreamChangedCount(lastDream) : null;
  const dreamActive = running || Boolean(lastDream?.running);

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Memories"
        meta={`${available} live · ${archived} archived · ${total} ever learned`}
        trailing={
          idlePct !== null && (
            <span
              data-slot="idle-share"
              className={cn("num shrink-0 whitespace-nowrap text-2xs", idlePct >= 50 ? "text-status-input" : "text-faint")}
            >
              {idlePct}% recalled, never used
            </span>
          )
        }
      >
        <div className="flex flex-col gap-2.5 px-3.5 py-3.5">
          {usage ? (
            <>
              <PressureBar used={usage.used} idle={usage.idle} untouched={usage.untouched} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs">
                <BandKey tone="bg-live" value={usage.used} label="used" href={browseHref({ usage: "used", sort: "used" })} />
                <BandKey tone="bg-amber" value={usage.idle} label="recalled, never used" href={browseHref({ usage: "idle", sort: "recalled" })} />
                <BandKey tone="bg-status-input" value={usage.untouched} label="never recalled" href={browseHref({ usage: "untouched", sort: "oldest" })} />
              </div>
            </>
          ) : (
            <p className="text-2xs text-faint">
              Usage breakdown needs a newer backend — restart Mandate to see it.
            </p>
          )}
        </div>
      </Section>

      {/* `grid-cols-1` spelled out: the implicit single track is `auto`, which
          sized to the widest line inside and pushed the page to 6,777px on a
          phone. An explicit 1fr track is bounded by the column. */}
      <div className="grid grid-cols-1 gap-6 @min-[52rem]:grid-cols-2">
        {/* Not "you have N things to archive". Archiving is maintenance's job —
            the reader's job is to notice when it stops keeping up, so this
            reports the backlog against what the last pass did about it, and
            leaves the judgement to a human who can see both. */}
        <Section
          title="Maintenance load"
          meta={
            changedCount !== null
              ? `last pass changed ${changedCount} ${changedCount === 1 ? "memory" : "memories"}`
              : undefined
          }
        >
          {usage && usage.idle > 0 ? (
            <Backlog idle={usage.idle} />
          ) : (
            <EmptyRow>Nothing is going unused.</EmptyRow>
          )}
          {collisions.map((collision) => (
            <NameCollisionRow key={collision.name} collision={collision} />
          ))}
        </Section>

        <Section
          title={lastDream?.running ? "Dreaming now" : "Last dream"}
          meta={lastDream ? formatRelativeTime(lastDream.startedAt) : undefined}
          trailing={
            <Button variant="outline" size="xs" disabled={dreamActive} onClick={onRunDream}>
              <Play className="size-3" />
              {dreamActive ? "Running" : "Run now"}
            </Button>
          }
        >
          {lastDream ? (
            <>
              <SectionRow minH="44">
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs">
                  {/* Motion means real activity — a dream in flight is exactly
                      that, and without this it rendered as a finished dream
                      that took zero seconds. */}
                  {lastDream.running && (
                    <span className="inline-flex items-center gap-1.5 text-live">
                      <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-live animate-live" />
                      running
                    </span>
                  )}
                  <span>
                    {lastDream.runs.length}{" "}
                    {lastDream.runs.length === 1 ? "partition" : "partitions"}
                    {formatDreamDuration(lastDream.startedAt, lastDream.finishedAt)
                      ? ` · ${formatDreamDuration(lastDream.startedAt, lastDream.finishedAt)}`
                      : ""}
                  </span>
                </span>
                <span className="num shrink-0 text-2xs text-faint">{dreamTally(lastDream)}</span>
              </SectionRow>
              <SectionRow>
                <SectionLink to="/memory?view=activity">
                  {lastDream.running ? "Watch it" : "See what changed"}
                </SectionLink>
              </SectionRow>
            </>
          ) : (
            <EmptyRow>No maintenance has run yet.</EmptyRow>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-6 @min-[52rem]:grid-cols-2">
        <Section
          title="What it leans on"
          meta="most used"
          trailing={<SectionLink to={browseHref({ usage: "used", sort: "used" })}>All</SectionLink>}
        >
          {topRecalled.length === 0 ? (
            <EmptyRow>Nothing has been used yet.</EmptyRow>
          ) : (
            topRecalled.map((entry) => (
              <SectionRow key={entry.id}>
                {/* The count is a magnitude, not a status, so it is not green. */}
                <span
                  className="num font-mono w-8 shrink-0 text-2xs text-faint"
                  title={`used ${entry.useCount}×, recalled ${entry.recallCount}×`}
                >
                  {entry.useCount}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{entry.content}</span>
              </SectionRow>
            ))
          )}
        </Section>

        <Section
          title="Where it lives"
          meta="by scope"
          trailing={<SectionLink to={browseHref({ scope: "feature" })}>Browse</SectionLink>}
        >
          <ScopeBars byScope={stats.byScope} />
        </Section>
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
            <SectionRow key={entry.id} minH="52" className="items-start py-2.5">
              <span className="num font-mono w-[52px] shrink-0 pt-0.5 text-2xs text-faint">
                {formatRelativeTime(entry.createdAt)}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block text-2xs text-chrome">{entryFacets(entry)}</span>
                <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-foreground">
                  {entry.content}
                </p>
              </div>
            </SectionRow>
          ))
        )}
      </Section>
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
 * How much the store is wasting: the count, what it means, and the way to
 * the memories themselves. What the last pass did about it sits in the
 * section's header line — two numbers side by side, no verdict, because
 * "falling behind" depends on how fast the backlog is growing and nothing
 * records that.
 */
function Backlog({ idle }: { idle: number }) {
  return (
    <SectionRow minH="44">
      <span className="num w-7 shrink-0 text-xs font-semibold">{idle}</span>
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        recalled into context, never once used
      </span>
      <SectionLink to={browseHref({ usage: "idle", sort: "recalled" })}>See them</SectionLink>
    </SectionRow>
  );
}

/** What the last pass touched: every action that is not a keep. */
function dreamChangedCount(dream: DreamBatch): number {
  return dream.runs.reduce((n, run) => {
    const c = run.actionCounts;
    return n + c.update + c.merge + c.archive + c.rescope;
  }, 0);
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

/** While running, appliedCount is not written yet, so reporting it produced
 *  "0 reviewed · 23 changed" — a contradiction. */
function dreamTally(dream: DreamBatch): string {
  const reviewed = dream.runs.reduce((n, run) => n + (run.appliedCount ?? 0), 0);
  const changed = dreamChangedCount(dream);
  return dream.running
    ? `${changed} changed so far`
    : `${reviewed} reviewed · ${changed} changed`;
}

function PressureBar({
  used,
  idle,
  untouched
}: {
  used: number;
  idle: number;
  untouched: number;
}) {
  const total = used + idle + untouched;
  if (total === 0) return null;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className="flex h-2 overflow-hidden rounded-full border border-border-soft"
      role="img"
      aria-label={`${used} used, ${idle} recalled but never used, ${untouched} never recalled`}
    >
      <span className="bg-live" style={{ width: pct(used) }} />
      <span className="bg-amber" style={{ width: pct(idle) }} />
      <span className="bg-status-input" style={{ width: pct(untouched) }} />
    </div>
  );
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
      className="inline-flex items-center gap-1.5 text-faint transition-colors hover:text-foreground"
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
          the name golib" — so it sits on the text's first line, not centred
          against the doors below. */}
      <span className="num w-7 shrink-0 text-xs font-semibold">{count}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{text}</div>
        <div className="flex flex-wrap items-center gap-x-3">
          {doors.map((door) => (
            <Link
              key={door.key}
              to={door.href}
              className="text-2xs text-foreground underline decoration-border underline-offset-[3px]"
            >
              {door.label}
            </Link>
          ))}
        </div>
      </div>
    </SectionRow>
  );
}

/** Scope is a place, not a status, so every bar is the same neutral fill. */
function ScopeBars({ byScope }: { byScope: MemoryStatsResponse["byScope"] }) {
  const rows = ["feature", "project", "user", "global"] as const;
  const max = Math.max(...rows.map((key) => byScope[key]), 1);
  return rows.map((key) => (
    <SectionRow key={key}>
      <Link
        to={browseHref({ scope: key })}
        className="flex flex-1 items-center gap-3 text-2xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="w-14 shrink-0">{key}</span>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sel">
          <span
            data-slot="scope-bar"
            className="block h-full rounded-full bg-faint"
            style={{ width: `${(byScope[key] / max) * 100}%` }}
          />
        </span>
        <span className="num w-8 text-right text-foreground">{byScope[key]}</span>
      </Link>
    </SectionRow>
  ));
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
