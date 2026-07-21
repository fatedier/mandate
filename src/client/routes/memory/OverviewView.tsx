import { type ReactNode } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { Link } from "react-router";
import type { MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
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
 * Every block is a doorway. That is the whole design — Overview deliberately
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

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-3 rounded-lg border border-border-soft bg-card p-4">
        <div className="flex flex-wrap items-baseline gap-x-7 gap-y-3">
          <Total value={available} label="live" tone="live" />
          <Total value={archived} label="archived" />
          <Total value={total} label="ever learned" />
          {idlePct !== null && (
            <div className="ml-auto text-right">
              <div
                className={cn(
                  "num text-2xl leading-none",
                  idlePct >= 50 ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {idlePct}%
              </div>
              <div className="text-2xs text-chrome">recalled, never used</div>
            </div>
          )}
        </div>

        {usage ? (
          <>
            <PressureBar used={usage.used} idle={usage.idle} untouched={usage.untouched} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs">
              <BandKey tone="bg-live" value={usage.used} label="used" href={browseHref({ usage: "used", sort: "used" })} />
              <BandKey tone="bg-status-review" value={usage.idle} label="recalled, never used" href={browseHref({ usage: "idle", sort: "recalled" })} />
              <BandKey tone="bg-destructive/60" value={usage.untouched} label="never recalled" href={browseHref({ usage: "untouched", sort: "oldest" })} />
            </div>
          </>
        ) : (
          <p className="text-2xs text-chrome">
            Usage breakdown needs a newer backend — restart Mandate to see it.
          </p>
        )}
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <Card label="Maintenance load">
          {/* Not "you have N things to archive". Archiving is maintenance's
              job — the reader's job is to notice when it stops keeping up, so
              this reports the backlog and what the last pass did about it, and
              leaves the judgement to a human who can see both. */}
          {usage && usage.idle > 0 ? (
            <Backlog idle={usage.idle} lastDream={lastDream} />
          ) : (
            <p className="text-xs text-chrome">Nothing is going unused.</p>
          )}
          {collisions.map((collision) => (
            <NameCollisionRow key={collision.name} collision={collision} />
          ))}
        </Card>

        <Card
          label={lastDream?.running ? "Dreaming now" : "Last dream"}
          trailing={lastDream ? formatRelativeTime(lastDream.startedAt) : undefined}
        >
          {lastDream ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {/* Motion means real activity — a dream in flight is exactly
                    that, and without this it rendered as a finished dream that
                    took zero seconds. */}
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
              </div>
              <div className="text-xs text-chrome">{dreamTally(lastDream)}</div>
            </>
          ) : (
            <p className="text-xs text-chrome">No maintenance has run yet.</p>
          )}
          <div className="mt-auto flex items-center gap-2 pt-1">
            <Door to="/memory?view=activity">
              {lastDream?.running ? "Watch it" : "See what changed"}
            </Door>
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              disabled={running || Boolean(lastDream?.running)}
              onClick={onRunDream}
            >
              <Play className="h-3 w-3" />
              <span className="ml-1.5">
                {running || lastDream?.running ? "Running" : "Run now"}
              </span>
            </Button>
          </div>
        </Card>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card
          label="What it leans on"
          trailing={<Door to={browseHref({ usage: "used", sort: "used" })}>All</Door>}
        >
          {topRecalled.length === 0 ? (
            <p className="text-xs text-chrome">Nothing has been used yet.</p>
          ) : (
            topRecalled.map((entry) => (
              <div key={entry.id} className="grid grid-cols-[3rem_1fr] items-baseline gap-2.5">
                <span
                  className="num text-right text-xs text-live"
                  title={`used ${entry.useCount}×, recalled ${entry.recallCount}×`}
                >
                  {entry.useCount}
                </span>
                <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {entry.content}
                </span>
              </div>
            ))
          )}
        </Card>

        <Card
          label="Where it lives"
          trailing={<Door to={browseHref({ scope: "feature" })}>Browse by scope</Door>}
        >
          <ScopeBars byScope={stats.byScope} />
        </Card>
      </div>

      <Card
        label="Just learned"
        trailing={<Door to="/memory?view=activity">Full activity</Door>}
      >
        {justLearned.length === 0 ? (
          <p className="text-xs text-chrome">Nothing learned yet.</p>
        ) : (
          justLearned.map((entry) => (
            <div key={entry.id} className="grid grid-cols-[4rem_1fr] items-baseline gap-2.5">
              <span className="text-2xs text-chrome">{formatRelativeTime(entry.createdAt)}</span>
              <div className="min-w-0">
                <span className="text-2xs text-chrome">{entryFacets(entry)}</span>
                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {entry.content}
                </p>
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

/**
 * How much the store is wasting, against what the last maintenance pass
 * actually changed. Two numbers side by side; no verdict, because "falling
 * behind" depends on how fast the backlog is growing and nothing records that.
 */
function Backlog({ idle, lastDream }: { idle: number; lastDream: DreamBatch | null }) {
  const changed = lastDream
    ? lastDream.runs.reduce((n, run) => {
        const c = run.actionCounts;
        return n + c.update + c.merge + c.archive + c.rescope;
      }, 0)
    : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="num text-lg text-status-review">{idle}</span>
        <span className="text-xs text-muted-foreground">
          recalled into context, never once used
        </span>
      </div>
      {changed !== null && (
        <p className="text-2xs text-chrome">
          Last maintenance pass changed <span className="num text-muted-foreground">{changed}</span>
          {changed === 1 ? " memory" : " memories"}.
        </p>
      )}
      <Door to={browseHref({ usage: "idle", sort: "recalled" })}>See what they are</Door>
    </div>
  );
}

/**
 * Names carried by more than one project, with the projects themselves.
 *
 * The projects and not just the count, because the id is the only thing that
 * differs and the card's whole job is to lead somewhere the two come apart.
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
  let reviewed = 0;
  let changed = 0;
  for (const run of dream.runs) {
    reviewed += run.appliedCount ?? 0;
    const counts = run.actionCounts;
    changed += counts.update + counts.merge + counts.archive + counts.rescope;
  }
  return dream.running
    ? `${changed} changed so far`
    : `${reviewed} reviewed · ${changed} changed`;
}

function Total({ value, label, tone }: { value: number; label: string; tone?: "live" }) {
  return (
    <div>
      <div className={cn("num text-2xl leading-none", tone === "live" && "text-live")}>{value}</div>
      <div className="mt-1 text-2xs text-chrome">{label}</div>
    </div>
  );
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
      <span className="bg-status-review" style={{ width: pct(idle) }} />
      <span className="bg-destructive/60" style={{ width: pct(untouched) }} />
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
      className="inline-flex items-center gap-1.5 text-chrome hover:text-foreground"
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} />
      <span className="num text-foreground">{value}</span>
      <span>{label}</span>
    </Link>
  );
}

function Card({
  label,
  trailing,
  children
}: {
  label: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-border-soft bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="label-micro text-chrome">{label}</h2>
        {typeof trailing === "string" ? (
          <span className="text-2xs text-chrome">{trailing}</span>
        ) : (
          trailing
        )}
      </div>
      {children}
    </section>
  );
}

function Door({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
    >
      {children}
      <ArrowUpRight className="h-3 w-3" aria-hidden />
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
      tone="review"
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
  tone,
  text,
  doors
}: {
  count: number;
  tone: "destructive" | "review";
  text: ReactNode;
  /** One or more ways out. A row with several is why this is a list rather
   *  than the single label-and-href it started as. */
  doors: Array<{ key: string; label: string; href: string }>;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          "num shrink-0 rounded px-1.5 py-0.5 text-2xs",
          tone === "destructive"
            ? "bg-destructive/15 text-destructive"
            : "bg-status-review/15 text-status-review"
        )}
      >
        {count}
      </span>
      <div className="min-w-0">
        {/* The badge is the sentence's first word — "2" then "projects share
            the name golib" — so the two have to stay on one line or the text
            reads as a fragment. */}
        <div className="text-xs text-muted-foreground">{text}</div>
        <div className="flex flex-wrap items-center gap-x-3">
          {doors.map((door) => (
            <Door key={door.key} to={door.href}>{door.label}</Door>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScopeBars({ byScope }: { byScope: MemoryStatsResponse["byScope"] }) {
  const rows = [
    { key: "feature", tone: "bg-phase-verifying" },
    { key: "project", tone: "bg-phase-working" },
    { key: "user", tone: "bg-phase-design" },
    { key: "global", tone: "bg-status-review" }
  ] as const;
  const max = Math.max(...rows.map((r) => byScope[r.key]), 1);
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <Link
          key={row.key}
          to={browseHref({ scope: row.key })}
          className="grid grid-cols-[4rem_1fr_2rem] items-center gap-2 text-xs text-chrome hover:text-foreground"
        >
          <span>{row.key}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <span
              className={cn("block h-full rounded-full", row.tone)}
              style={{ width: `${(byScope[row.key] / max) * 100}%` }}
            />
          </span>
          <span className="num text-right text-foreground">{byScope[row.key]}</span>
        </Link>
      ))}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border-soft bg-card p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-3 h-2 w-full" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
      </div>
    </div>
  );
}
