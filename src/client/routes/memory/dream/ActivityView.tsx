import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Settings2 } from "lucide-react";
import { Link } from "react-router";
import type {
  SkillReviewRunDto, SkillTidyRunDto,
  SkillReviewRunsResponse,
  MemoryDreamRunDto,
  MemoryDreamRunsResponse,
  MemoryEntriesResponse,
  MemoryEntryDto,
  MemoryStatsResponse
} from "@shared/api-contracts";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { formatClockMinutes, formatDateTimeTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { entryFacets, previewText, projectNameResolver } from "../memory-entry";
import { MemoryDetailDialog } from "../MemoryEntryDetail";
import {
  ACTIVITY_KINDS,
  buildActivityFeed,
  dreamTotals,
  groupByDay,
  type ActivityEventKind,
  type ActivityKind,
  type MemoryEvent
} from "./memory-activity";
import { formatDreamDuration, groupRunsIntoDreams, type DreamBatch } from "./memory-run-model";
import { DreamPartitionPill } from "./shared";
import { partitionTally } from "./helpers";
import { useRunDialog } from "./use-run-dialog";
import { runDreamNow } from "./run-dream";
import { errorText } from "@shared/error-text";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { personalAgentLabel } from "@/lib/personal-agent-label";

const SAMPLE = 25;
const DREAM_SAMPLE = 30;

const KIND_LABEL: Record<ActivityKind | "all", string> = {
  all: "Everything",
  learned: "Learned",
  updated: "Updated",
  forgotten: "Forgotten",
  dream: "Dreams"
};

/**
 * The store as a stream: what it learned, what maintenance threw away, and the
 * dreams that did the throwing — one timeline instead of a memory list beside
 * a separate maintenance log.
 */
export function ActivityView({ stats = null }: { stats?: MemoryStatsResponse | null }) {
  const resolveProject = useMemo(() => projectNameResolver(stats), [stats]);
  const [learned, setLearned] = useState<MemoryEntryDto[]>([]);
  const [updated, setUpdated] = useState<MemoryEntryDto[]>([]);
  const [archived, setArchived] = useState<MemoryEntryDto[]>([]);
  const [dreams, setDreams] = useState<DreamBatch[]>([]);
  const [reviews, setReviews] = useState<SkillReviewRunDto[]>([]);
  const [tidies, setTidies] = useState<SkillTidyRunDto[]>([]);
  // The reviews are read apart: their failure is said, and the rest of the
  // feed still shows.
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Why the feed's last read failed, until one succeeds. Apart from `error`,
  // which is an action's (opening or running a dream).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const [triggering, setTriggering] = useState(false);
  const [notice, setNotice] = useState("");

  const runDialog = useRunDialog(resolveProject);
  const [openEntry, setOpenEntry] = useState<MemoryEntryDto | null>(null);

  // Only the newest read answers: Retry and Run now can overlap, and an
  // older read landing last must not undo a newer answer.
  const readSeq = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++readSeq.current;
    setLoading(true);
    // The reviews are their own read: their answer or failure is kept
    // whatever the rest of the feed's read does, under the same newest-read rule.
    const reviewsRead = (async () => {
      try {
        const answer = await readJson<SkillReviewRunsResponse>(await fetch(api.skillReviews, { signal }));
        if (seq !== readSeq.current) return;
        setReviews(answer.runs);
        setTidies(answer.tidies ?? []);
        setReviewsError(null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || seq !== readSeq.current) return;
        setReviewsError(errorText(err));
      }
    })();
    try {
      const entries = (query: string) =>
        fetch(api.memoryEntries(query), { signal }).then((res) =>
          readJson<MemoryEntriesResponse>(res)
        );
      const [created, rewritten, gone, runs] = await Promise.all([
        entries(`status=all&learned=1&sort=created&limit=${SAMPLE}`),
        entries(`status=all&updated=1&limit=${SAMPLE}`),
        entries(`status=archived&forgotten=1&sort=recent&limit=${SAMPLE}`),
        fetch(`${api.memoryDreamRuns}?limit=${DREAM_SAMPLE}`, { signal }).then((res) =>
          readJson<MemoryDreamRunsResponse>(res)
        )
      ]);
      if (seq !== readSeq.current) return;
      setLearned(created.entries);
      setUpdated(rewritten.entries);
      setArchived(gone.entries);
      setDreams(groupRunsIntoDreams(runs.runs));
      setError("");
      setLoadError(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || seq !== readSeq.current) return;
      setLoadError(errorText(err));
    } finally {
      // Loading until both are read: an empty feed says nothing happened
      // only once the reviews have answered too.
      await reviewsRead;
      if (seq === readSeq.current) setLoading(false);
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
    () => buildActivityFeed({ learned, updated, archived, dreams, reviews, tidies }),
    [learned, updated, archived, dreams, reviews, tidies]
  );
  const filtered = useMemo(
    () => (kind === "all" ? feed : feed.filter((event) => event.kind === kind)),
    [feed, kind]
  );
  const days = useMemo(() => groupByDay(filtered), [filtered]);

  const triggerDream = async () => {
    setTriggering(true);
    setNotice("");
    setError("");
    try {
      const refused = await runDreamNow();
      await load();
      if (refused) setError(refused);
      else setNotice("Dream finished.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 pointer-coarse:gap-y-5">
        {/* 16px between wrapped rows on a touch screen: a 28px filter's area
            reaches 8px past it. */}
        <div className="flex flex-wrap gap-1 pointer-coarse:gap-y-4">
          {(["all", ...ACTIVITY_KINDS] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              className={cn(
                "hit relative rounded-md border px-2.5 py-1 text-xs transition-colors",
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
            <span className="ml-1.5">{triggering ? "Running…" : "Run now"}</span>
          </Button>
        </div>
      </div>

      {error || runDialog.error ? <p className="text-xs text-destructive">{error || runDialog.error}</p> : null}
      {notice ? <p className="text-xs text-amber">{notice}</p> : null}

      {days.length > 0 && loadError && (
        <InlineError detail={loadError} onRetry={() => void load()}>
          Couldn't refresh activity. Showing the last loaded events.
        </InlineError>
      )}

      {/* Beside the feed, or a feed that was read; when nothing could be read
          the feed's own error says it for the whole view. */}
      {reviewsError && !(days.length === 0 && loadError) && (
        <InlineError detail={reviewsError} onRetry={() => void load()}>Couldn't load skill reviews.</InlineError>
      )}

      {days.length === 0 ? (
        loading ? <LoadingLine />
          // Said alone: "Nothing has happened yet" would claim the feed was read.
          : loadError ? <InlineError detail={loadError} onRetry={() => void load()}>Couldn't load activity.</InlineError>
            // Not while the reviews are unread: they may be all there is.
            : reviewsError ? null
              : <p className="py-12 text-center text-sm text-chrome">Nothing has happened yet.</p>
      ) : (
        <div className="flex flex-col">
          {days.map((day) => (
            <section key={day.key}>
              <h3 className="sticky top-0 z-10 bg-background py-1.5 label-group">
                {day.label}
              </h3>
              <div className="flex flex-col">
                {day.events.map((event) => (
                  <EventRow key={event.id} event={event} onOpenRun={(run) => void runDialog.openRun(run)} onOpenEntry={setOpenEntry} resolveProject={resolveProject} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {runDialog.dialog}
      <MemoryDetailDialog
        entry={openEntry}
        open={openEntry !== null}
        onOpenChange={(open) => !open && setOpenEntry(null)}
        resolveProject={resolveProject}
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

// The dream node stays a filled dot: shape carries the distinction from the
// hollow learned/archived nodes without needing a colour.
const NODE_TONE: Record<ActivityEventKind, string> = {
  learned: "border-live",
  updated: "border-phase-working",
  forgotten: "border-amber",
  dream: "border-muted-foreground bg-muted-foreground",
  // A background job's row, as the dream's.
  review: "border-muted-foreground bg-muted-foreground",
  tidy: "border-muted-foreground bg-muted-foreground"
};

const VERB_TONE: Record<ActivityEventKind, string> = {
  learned: "text-live",
  updated: "text-phase-working",
  forgotten: "text-amber",
  dream: "text-muted-foreground",
  review: "text-muted-foreground",
  tidy: "text-muted-foreground"
};

const VERB: Record<ActivityKind, string> = {
  learned: "Learned",
  updated: "Updated",
  forgotten: "Forgotten",
  dream: "Dream"
};

function EventRow({
  event,
  onOpenRun,
  onOpenEntry,
  resolveProject
}: {
  event: MemoryEvent;
  onOpenRun: (run: MemoryDreamRunDto) => void;
  onOpenEntry: (entry: MemoryEntryDto) => void;
  resolveProject: (projectId: string) => string | undefined;
}) {
  return (
    <div className="grid grid-cols-[3.5rem_1.25rem_minmax(0,1fr)] items-start gap-x-3">
      {/* To the minute, like the transcript's clocks; the second is in the title. */}
      <span data-slot="memory-event-time" className="pt-1 text-right text-2xs tabular-nums text-chrome" title={formatDateTimeTitle(event.at)}>
        {formatClockMinutes(event.at)}
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
          <DreamEvent dream={event.dream} onOpenRun={onOpenRun} />
        ) : event.kind === "review" ? (
          <ReviewEvent run={event.run} />
        ) : event.kind === "tidy" ? (
          <TidyEvent run={event.run} />
        ) : (
          <EntryEvent event={event} resolveProject={resolveProject} onOpen={() => onOpenEntry(event.entry)} />
        )}
      </div>
    </div>
  );
}

function EntryEvent({
  event,
  resolveProject,
  onOpen
}: {
  event: Extract<MemoryEvent, { entry: MemoryEntryDto }>;
  resolveProject: (projectId: string) => string | undefined;
  onOpen: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn("font-medium", VERB_TONE[event.kind])}>{VERB[event.kind]}</span>
        <span className="text-2xs text-chrome">{entryFacets(event.entry, resolveProject)}</span>
      </div>
      {/* Long words shortened, and wrapped rather than run past the edge:
          a clamp cuts an overlong first line silently. */}
      <button
        type="button"
        onClick={onOpen}
        data-slot="memory-preview"
        className="mt-0.5 line-clamp-2 break-words text-left text-xs leading-relaxed text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
      >
        {event.kind === "updated" && event.added && <span className="text-diff-add-fg">+ </span>}
        {previewText(event.text)}
      </button>
      {event.kind === "forgotten" && (
        <p data-slot="forgotten-reason" className="mt-0.5 line-clamp-2 break-words text-2xs italic text-chrome">
          {event.reason}
        </p>
      )}
    </>
  );
}

/** What a requested skill review did, as its row says it. */
function reviewState(run: SkillReviewRunDto): string {
  if (run.status === "running") return "Running";
  if (run.status === "failed") return "Failed";
  const name = run.skillName ?? "";
  switch (run.outcome) {
    case "created": return `Wrote ${name}`;
    case "changed": return `Changed ${name}`;
    case "restored": return `Restored ${name}`;
    default: return "Nothing to change";
  }
}

function ReviewEvent({ run }: { run: SkillReviewRunDto }) {
  const agentLabel = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const thread = run.threadKind === "personal" ? agentLabel : run.threadTitle;
  const state = reviewState(run);
  const why = run.status === "failed" ? run.error : run.reason;
  return (
    <div data-slot="review-event">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {/* A long title or name breaks inside the column, never past it. */}
        <span data-slot="review-title" className={cn("min-w-0 font-medium [overflow-wrap:anywhere]", VERB_TONE.review)}>{thread ? `Skill review of ${thread}` : "Skill review"}</span>
        {run.skillId && run.revision !== null && run.status === "succeeded" ? (
          <Link
            data-slot="review-state"
            to={`/memory?view=skills&skill=${encodeURIComponent(run.skillId)}&revision=${run.revision}`}
            className="hit relative min-w-0 text-2xs text-foreground underline underline-offset-2 [overflow-wrap:anywhere] hover:text-live"
          >
            {state}
          </Link>
        ) : (
          <span data-slot="review-state" className={cn("min-w-0 text-2xs [overflow-wrap:anywhere]", run.status === "running" ? "text-live" : "text-chrome")}>{state}</span>
        )}
      </div>
      {why && <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{why}</p>}
    </div>
  );
}

/** A tidy of all skills: its state, or a link per skill it changed, to the
 *  revision it wrote; its one-sentence outcome under it. */
function TidyEvent({ run }: { run: SkillTidyRunDto }) {
  const why = run.status === "failed" ? run.error : run.reason;
  const quiet = run.status === "running" ? "Running" : run.status === "failed" ? "Failed" : run.changed.length === 0 ? "Nothing to change" : null;
  return (
    <div data-slot="tidy-event">
      {/* Its links may wrap: on a touch screen the rows sit far enough apart
          that their 44 px touch areas do not overlap. */}
      <div className="flex flex-wrap items-center gap-2 text-sm pointer-coarse:gap-y-7">
        <span data-slot="review-title" className={cn("min-w-0 font-medium [overflow-wrap:anywhere]", VERB_TONE.tidy)}>Skill tidy</span>
        {quiet ? (
          <span data-slot="review-state" className={cn("min-w-0 text-2xs [overflow-wrap:anywhere]", run.status === "running" ? "text-live" : "text-chrome")}>{quiet}</span>
        ) : run.changed.map((c) => (
          <Link
            key={`${c.skillId}:${c.revision}`}
            data-slot="review-state"
            to={`/memory?view=skills&skill=${encodeURIComponent(c.skillId)}&revision=${c.revision}`}
            className="hit relative min-w-0 text-2xs text-foreground underline underline-offset-2 [overflow-wrap:anywhere] hover:text-live"
          >
            {`Changed ${c.skillName ?? ""}`}
          </Link>
        ))}
      </div>
      {why && <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{why}</p>}
    </div>
  );
}

function DreamEvent({ dream, onOpenRun }: { dream: DreamBatch; onOpenRun: (run: MemoryDreamRunDto) => void }) {
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
      {/* One row per partition, each opening that partition's run. */}
      <div className="mt-1 flex w-full flex-col rounded-md border border-border-soft bg-panel p-1">
        {dream.runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => onOpenRun(run)}
            className="flex min-h-7 min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-sel pointer-coarse:min-h-11"
          >
            <DreamPartitionPill run={run} />
            <span className="min-w-0 truncate text-muted-foreground">{partitionTally(run)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
