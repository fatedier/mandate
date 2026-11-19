import { useEffect, useMemo, useState } from "react";
import { Fold } from "@/components/Fold";
import { ChevronRight, CircleHelp } from "lucide-react";
import { foldSteps } from "@shared/plan-text";
import { planRounds } from "@shared/plan-rounds";
import { planProgress } from "@shared/worker-state";
import { remoteWebBase } from "@shared/git-web";
import { Section } from "@/components/Section";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { errorText } from "@shared/error-text";
import { fetchWholePlan, useWorkerPlan, useWorkerPlansStore } from "@/store/worker-plans";
import type { WorkerPlanDto } from "@shared/api/plans";
import { useWorkerWakeActive } from "@/store/wake-activity";
import { useWorkItemsStore } from "@/store/work-items";
import { workerStatePill, type PillTone } from "@/lib/worker-status";
import { workerPaneHref } from "@/lib/worker-href";
import { formatCalendarDate } from "@/lib/format";
import { usePaneLocations } from "@/lib/pane-names";
import { cn } from "@/lib/utils";
import { MarkdownView } from "@/components/MarkdownView";
import type { NoteLinkContext } from "./note-links";
import { PlanStepRow } from "./PlanStepRow";
import { WorkRecordRow } from "./WorkRecordRow";

const BAR: Record<PillTone, string> = {
  blue: "bg-phase-working", amber: "bg-amber", green: "bg-phase-done",
  red: "bg-destructive", neutral: "bg-faint", cyan: "bg-faint", violet: "bg-faint"
};

interface Props {
  workerId: string;
  projectSlug: string;
  workerSlug: string;
  gitRemote: string | null;
  /** Canvas id → title, for report links in notes. */
  canvasTitles: Map<string, string>;
}

/** The worker's plan, as its worker keeps it: the state and the conclusion
 *  first, then progress, the goal, the open questions, and the steps of the
 *  current work, with older done steps folded into a count until asked for.
 *  The earlier goals' finished steps fold into one row, by goal. */
export function WorkerPlanCard({ workerId, projectSlug, workerSlug, gitRemote, canvasTitles }: Props) {
  const plan = useWorkerPlan(workerId);
  const running = useWorkerWakeActive(workerId);
  const failedAt = useWorkItemsStore((s) => {
    for (const it of s.items.values()) if (it.workerId === workerId) return it.failedAt ?? null;
    return null;
  });
  const failedKind = useWorkItemsStore((s) => {
    for (const it of s.items.values()) if (it.workerId === workerId) return it.failedKind ?? null;
    return null;
  });
  const panes = usePaneLocations();
  const [expanded, setExpanded] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  // The page's plan counts earlier work (earlierWork); its steps come with the
  // whole plan, read while earlier work is open and again as the plan moves on.
  const [whole, setWhole] = useState<{ workerId: string; plan: WorkerPlanDto | null; error: string | null } | null>(null);
  const [wholeAttempt, setWholeAttempt] = useState(0);
  const readWhole = earlierOpen && Boolean(plan?.earlierWork);
  const planStamp = plan?.updatedAt ?? null;
  useEffect(() => {
    if (!readWhole) return;
    let current = true;
    fetchWholePlan(workerId).then(
      (read) => { if (current) setWhole({ workerId, plan: read, error: null }); },
      (err: unknown) => { if (current) setWhole((was) => ({ workerId, plan: was?.workerId === workerId ? was.plan : null, error: errorText(err) })); }
    );
    return () => { current = false; };
  }, [readWhole, workerId, planStamp, wholeAttempt]);
  // Until its own fetch answers, a worker with no pushed plan is not known
  // to have none. Keyed by worker, so another worker's answer never stands.
  const [fetched, setFetched] = useState<{ workerId: string; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The startup lists cap how many work items they bring, and pushes can be
  // missed while disconnected: the open worker fetches its own.
  useEffect(() => {
    let current = true;
    useWorkerPlansStore.getState().fetchOne(workerId).then(
      () => { if (current) setFetched({ workerId, error: null }); },
      (err: unknown) => { if (current) setFetched({ workerId, error: errorText(err) }); }
    );
    return () => { current = false; };
  }, [workerId, attempt]);
  useEffect(() => {
    void useWorkItemsStore.getState().fetchByWorker(workerId).catch(() => {});
  }, [workerId]);
  const answer = fetched?.workerId === workerId ? fetched : null;
  const maxStepId = Math.max(0, ...(plan?.steps ?? []).map((step) => step.id), plan?.earlierWork?.lastStepId ?? 0);
  const ctx = useMemo<NoteLinkContext>(() => ({
    // A pane a note names may belong to another worker: link to where it is.
    paneHref: (paneId) => {
      const at = panes.get(paneId);
      if (at) return workerPaneHref(at.sessionName, at.windowName, paneId);
      // No window of its own (an archived worker): nothing to link to.
      return projectSlug && workerSlug ? workerPaneHref(projectSlug, workerSlug, paneId) : null;
    },
    paneName: (paneId) => panes.get(paneId)?.name ?? undefined,
    canvasTitle: (id) => canvasTitles.get(id),
    webBase: remoteWebBase(gitRemote),
    maxStepId
  }), [projectSlug, workerSlug, panes, canvasTitles, gitRemote, maxStepId]);

  const pill = workerStatePill(plan, failedAt, failedKind, running);
  const { done, total } = planProgress(plan);
  // The conclusion is the headline; a worker with nothing written yet says
  // so; a plan with a goal or steps but no conclusion has no headline.
  const nothingWritten = total === 0 && !plan?.goal && !plan?.openQuestions.length;
  const headline = plan?.conclusion?.trim() || (nothingWritten ? "No plan yet — the worker writes one when it starts." : null);
  const { current, earlier: localEarlier } = planRounds(plan ?? { steps: [] });
  const counted = plan?.earlierWork ?? null;
  const earlierGoals = counted ? counted.goals : localEarlier.length;
  const earlierSteps = counted ? counted.steps : localEarlier.reduce((n, round) => n + round.steps.length, 0);
  const wholeHere = whole?.workerId === workerId ? whole : null;
  const earlier = counted ? (wholeHere?.plan ? planRounds(wholeHere.plan).earlier : null) : localEarlier;
  const folded = foldSteps(current);
  const steps = expanded ? current : folded.shown;

  if (!plan && (!answer || answer.error !== null)) {
    return (
      <Section title="Plan" aria-label="Plan">
        <div data-slot="plan-card" className="p-4">
          {answer?.error != null
            ? (
              <InlineError detail={answer.error} onRetry={() => { setFetched(null); setAttempt((n) => n + 1); }}>
                Couldn't load the plan.
              </InlineError>
            )
            : <LoadingLine />}
        </div>
      </Section>
    );
  }

  return (
    <Section title="Plan" aria-label="Plan" trailing={<span data-slot="worker-state" className={cn("pill", `pill-${pill.tone}`)}>{pill.label}</span>}>
      <div data-slot="plan-card" className="flex flex-col gap-3.5 p-4">
        {headline && (
          <p data-slot="plan-conclusion" className="m-0 text-base font-semibold text-balance">{headline}</p>
        )}
        {total > 0 && (
          <div className="flex items-center gap-2.5">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sel">
              {/* It grows to the steps done (and turns colour) gently. */}
              <span data-slot="plan-progress-fill" className={cn("block h-1.5 rounded-full transition-[width,background-color] duration-300 ease-(--ease-ui) motion-reduce:transition-none", BAR[pill.tone])} style={{ width: `${Math.round((done / total) * 100)}%` }} />
            </span>
            <span data-slot="plan-progress" className="num shrink-0 text-xs text-muted-foreground">{done} of {total} done</span>
          </div>
        )}
        {plan?.goal && (
          <div className="flex flex-col gap-0.5">
            <span className="text-2xs font-semibold text-chrome">Goal</span>
            <p data-slot="plan-goal" className="m-0 text-sm text-muted-foreground">{plan.goal}</p>
          </div>
        )}
        {plan && plan.openQuestions.length > 0 && (
          <div data-slot="plan-questions" className="flex flex-col gap-1.5 rounded-md bg-amber/10 px-3 py-2.5">
            <span className="text-2xs font-semibold text-amber">Open questions</span>
            {plan.openQuestions.map((question) => (
              // Drawn as the chat draws it: a canvas link is a link.
              <div key={question} className="flex gap-2 text-sm">
                <CircleHelp className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden />
                <MarkdownView text={question} dense />
              </div>
            ))}
          </div>
        )}
        {(total > 0 || earlierGoals > 0) && (
          <ul className="-mx-2 m-0 flex flex-col p-0">
            {earlierGoals > 0 && (
              <li className="list-none">
                <button type="button" data-slot="plan-earlier-work" aria-expanded={earlierOpen} onClick={() => setEarlierOpen(!earlierOpen)}
                  className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-chrome transition-colors hover:bg-sel hover:text-foreground pointer-coarse:min-h-11">
                  <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", earlierOpen && "rotate-90")} />
                  {earlierOpen
                    ? "Hide earlier work"
                    : `Earlier work · ${earlierGoals} goal${earlierGoals === 1 ? "" : "s"}, ${earlierSteps} step${earlierSteps === 1 ? "" : "s"}`}
                </button>
                <Fold open={earlierOpen}>
                {wholeHere?.error != null && (
                  <div data-slot="plan-earlier-error" className="px-2 pb-2">
                    <InlineError detail={wholeHere.error} onRetry={() => setWholeAttempt((n) => n + 1)}>Couldn't load earlier work.</InlineError>
                  </div>
                )}
                {!earlier && wholeHere?.error == null && <div className="px-2 pb-2"><LoadingLine /></div>}
                {earlier && (
                  <ul className="m-0 flex flex-col gap-2 p-0 pb-2">
                    {earlier.map((round) => (
                      <li key={round.changedAt} data-slot="plan-earlier-round" className="list-none">
                        <div className="flex items-baseline gap-2 px-2 pt-1.5">
                          <span data-slot="plan-round-goal" title={round.goal} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{round.goal}</span>
                          <span data-slot="plan-round-meta" className="num shrink-0 text-2xs text-faint">
                            {round.steps.length} step{round.steps.length === 1 ? "" : "s"} · {formatCalendarDate(round.changedAt)}
                          </span>
                        </div>
                        <ul className="m-0 flex flex-col p-0">
                          {round.steps.map((step) => <PlanStepRow key={step.id} step={step} ctx={ctx} />)}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
                </Fold>
              </li>
            )}
            {/* A toggle, written like the panel's "› Archived": "2 steps done
                earlier" read as a note, and once open nothing folded the
                steps again. */}
            {folded.earlierDone > 0 && (
              <li className="list-none">
                <button type="button" data-slot="plan-earlier" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
                  className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-chrome transition-colors hover:bg-sel hover:text-foreground pointer-coarse:min-h-11">
                  <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
                  {expanded ? "Hide earlier steps" : `Show ${folded.earlierDone} earlier step${folded.earlierDone === 1 ? "" : "s"}`}
                </button>
              </li>
            )}
            {steps.map((step) => <PlanStepRow key={step.id} step={step} ctx={ctx} />)}
          </ul>
        )}
        {/* The worker's history, beside its current plan. */}
        <WorkRecordRow workerId={workerId} />
      </div>
    </Section>
  );
}
