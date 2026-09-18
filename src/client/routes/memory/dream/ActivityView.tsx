import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, Settings2 } from "lucide-react";
import { Link } from "react-router";
import type {
  MemoryDreamActionDto,
  MemoryDreamRunDetailResponse,
  MemoryDreamRunDto,
  MemoryDreamRunsResponse,
  MemoryEntriesResponse,
  MemoryEntryDto
} from "@shared/api-contracts";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { formatClockTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { entryFacets } from "../memory-entry";
import { DreamRunDialog } from "./DreamRunDialog";
import {
  ACTIVITY_KINDS,
  buildActivityFeed,
  dreamTotals,
  groupByDay,
  type ActivityKind,
  type MemoryEvent
} from "./memory-activity";
import { formatDreamDuration, groupRunsIntoDreams, type DreamBatch } from "./memory-run-model";
import { DreamPartitionPill } from "./shared";

const SAMPLE = 25;
const DREAM_SAMPLE = 30;

const KIND_LABEL: Record<ActivityKind | "all", string> = {
  all: "Everything",
  learned: "Learned",
  archived: "Archived",
  dream: "Dreams"
};

/**
 * The store as a stream: what it learned, what maintenance threw away, and the
 * dreams that did the throwing — one timeline instead of a memory list beside
 * a separate maintenance log.
 */
export function ActivityView() {
  const [learned, setLearned] = useState<MemoryEntryDto[]>([]);
  const [archived, setArchived] = useState<MemoryEntryDto[]>([]);
  const [dreams, setDreams] = useState<DreamBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const [triggering, setTriggering] = useState(false);
  const [notice, setNotice] = useState("");

  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openActions, setOpenActions] = useState<MemoryDreamActionDto[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const entries = (query: string) =>
        fetch(api.memoryEntries(query), { signal }).then((res) =>
          readJson<MemoryEntriesResponse>(res)
        );
      const [created, gone, runs] = await Promise.all([
        entries(`status=all&sort=created&limit=${SAMPLE}`),
        entries(`status=archived&sort=recent&limit=${SAMPLE}`),
        fetch(`${api.memoryDreamRuns}?limit=${DREAM_SAMPLE}`, { signal }).then((res) =>
          readJson<MemoryDreamRunsResponse>(res)
        )
      ]);
      setLearned(created.entries);
      setArchived(gone.entries);
      setDreams(groupRunsIntoDreams(runs.runs));
      setError("");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred by a zero timer, like the rest of this page: calling load straight
  // from the effect sets loading state during the commit.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const feed = useMemo(
    () => buildActivityFeed({ learned, archived, dreams }),
    [learned, archived, dreams]
  );
  const filtered = useMemo(
    () => (kind === "all" ? feed : feed.filter((event) => event.kind === kind)),
    [feed, kind]
  );
  const days = useMemo(() => groupByDay(filtered), [filtered]);

  const openDream = async (dream: DreamBatch) => {
    // A dream's rewrites live in its runs; open the partition that changed the
    // most, which is the one worth reading.
    const target = [...dream.runs].sort((a, b) => changedIn(b) - changedIn(a))[0];
    if (!target) return;
    try {
      const payload = await readJson<MemoryDreamRunDetailResponse>(
        await fetch(api.memoryDreamRun(target.id))
      );
      if ("run" in payload) {
        setOpenRunId(target.id);
        setOpenActions(payload.actions);
        setDialogOpen(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const triggerDream = async () => {
    setTriggering(true);
    setNotice("");
    try {
      await fetch(api.memoryDreamRuns, { method: "POST" });
      await load();
      setNotice("Dream finished.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggering(false);
    }
  };

  const openRun = dreams.flatMap((d) => d.runs).find((r) => r.id === openRunId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {(["all", ...ACTIVITY_KINDS] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                kind === option
                  ? "border-border bg-sel text-foreground"
                  : "border-border-soft text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setKind(option)}
            >
              {KIND_LABEL[option]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {/* 28px, both of them: the body's controls sit a step under the
              header band's, and the link matches the button beside it. */}
          <Button variant="ghost" size="xs" asChild>
            <Link to="/settings?tab=memory">
              <Settings2 className="h-3.5 w-3.5" />
              <span className="ml-1.5">Configure</span>
            </Link>
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={triggering}
            onClick={() => void triggerDream()}
          >
            <Play className="h-3.5 w-3.5" />
            <span className="ml-1.5">{triggering ? "Running" : "Run now"}</span>
          </Button>
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-amber">{notice}</p> : null}

      {days.length === 0 ? (
        <p className="py-12 text-center text-sm text-chrome">
          {loading ? "Loading activity…" : "Nothing has happened yet."}
        </p>
      ) : (
        <div className="flex flex-col">
          {days.map((day) => (
            <section key={day.key}>
              <h3 className="sticky top-0 z-10 bg-background py-1.5 label-micro text-chrome">
                {day.label}
              </h3>
              <div className="flex flex-col">
                {day.events.map((event) => (
                  <EventRow key={event.id} event={event} onOpenDream={openDream} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <DreamRunDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        run={openRun}
        actions={openRun ? openActions : []}
      />
    </div>
  );
}

/** "3 partitions · 11m 49s · 18 reviewed, 7 changed" — or, while running,
 *  the parts that are actually known yet. */
function dreamSummary(dream: DreamBatch, reviewed: number | null, changed: number): string {
  const parts = [`${dream.runs.length} ${dream.runs.length === 1 ? "partition" : "partitions"}`];
  const duration = formatDreamDuration(dream.startedAt, dream.finishedAt);
  if (duration) parts.push(duration);
  parts.push(
    reviewed !== null ? `${reviewed} reviewed, ${changed} changed` : `${changed} changed so far`
  );
  return parts.join(" · ");
}

function changedIn(run: MemoryDreamRunDto): number {
  const c = run.actionCounts;
  return c.update + c.merge + c.archive + c.rescope;
}

// The dream node stays a filled dot: shape carries the distinction from the
// hollow learned/archived nodes without needing a colour.
const NODE_TONE: Record<ActivityKind, string> = {
  learned: "border-live",
  archived: "border-amber",
  dream: "border-muted-foreground bg-muted-foreground"
};

const VERB_TONE: Record<ActivityKind, string> = {
  learned: "text-live",
  archived: "text-amber",
  dream: "text-muted-foreground"
};

const VERB: Record<ActivityKind, string> = {
  learned: "Learned",
  archived: "Archived",
  dream: "Dream"
};

function EventRow({
  event,
  onOpenDream
}: {
  event: MemoryEvent;
  onOpenDream: (dream: DreamBatch) => void;
}) {
  return (
    <div className="grid grid-cols-[3.5rem_1.25rem_minmax(0,1fr)] items-start gap-x-3">
      <span className="pt-1 text-right text-2xs tabular-nums text-chrome" title={event.at}>
        {formatClockTime(event.at)}
      </span>
      {/* One continuous spine with a node per event, so the column reads as a
          timeline rather than a stack of unrelated rows. */}
      <span className="relative flex justify-center self-stretch pt-1.5">
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-soft"
        />
        <span
          aria-hidden
          className={cn(
            "relative h-2.5 w-2.5 shrink-0 rounded-full border-2 bg-background",
            NODE_TONE[event.kind]
          )}
        />
      </span>
      <div className="min-w-0 pb-3">
        {event.kind === "dream" ? (
          <DreamEvent dream={event.dream} onOpen={() => onOpenDream(event.dream)} />
        ) : (
          <EntryEvent event={event} />
        )}
      </div>
    </div>
  );
}

function EntryEvent({ event }: { event: Extract<MemoryEvent, { entry: MemoryEntryDto }> }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn("font-medium", VERB_TONE[event.kind])}>{VERB[event.kind]}</span>
        <span className="text-2xs text-chrome">{entryFacets(event.entry)}</span>
        {/* Why it went: an archive after hundreds of unused recalls is a very
            different event from an archive of something nothing ever read. */}
        {event.kind === "archived" && event.entry.recallCount > 0 && (
          <span className="text-2xs text-chrome">
            after {event.entry.recallCount} recalls
            {event.entry.useCount === 0 ? ", never used" : ""}
          </span>
        )}
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {event.entry.content}
      </p>
    </>
  );
}

function DreamEvent({ dream, onOpen }: { dream: DreamBatch; onOpen: () => void }) {
  const { reviewed, changed } = dreamTotals(dream);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn("font-medium", VERB_TONE.dream)}>
          {dream.running ? "Dreaming" : VERB.dream}
        </span>
        {/* Motion means real activity, per the signal grammar — and a dream in
            flight is the clearest case of it there is. */}
        {dream.running && (
          <span className="inline-flex items-center gap-1.5 text-2xs text-live">
            <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-live animate-live" />
            running
          </span>
        )}
        <span className="text-2xs text-chrome">{dreamSummary(dream, reviewed, changed)}</span>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="mt-1 flex w-full flex-col gap-1.5 rounded-md border border-border-soft bg-panel px-3 py-2 text-left hover:bg-sel"
      >
        {dream.runs.map((run) => (
          <div key={run.id} className="flex min-w-0 items-center gap-2 text-xs">
            <DreamPartitionPill run={run} />
            <span className="min-w-0 truncate text-muted-foreground">{partitionTally(run)}</span>
          </div>
        ))}
      </button>
    </div>
  );
}

function partitionTally(run: MemoryDreamRunDto): string {
  const c = run.actionCounts;
  const parts: string[] = [];
  if (c.update) parts.push(`${c.update} updated`);
  if (c.merge) parts.push(`${c.merge} merged`);
  if (c.archive) parts.push(`${c.archive} archived`);
  if (c.rescope) parts.push(`${c.rescope} rescoped`);
  if (c.keep) parts.push(`${c.keep} kept`);
  if (parts.length > 0) return parts.join(" · ");
  return run.status === "running" ? "working…" : "nothing changed";
}
