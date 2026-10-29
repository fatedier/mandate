import type { WorkItem, WorkItemStore } from "./work-item-store.js";
import type { AgentStore } from "./agent-store.js";
import type { PlanStore } from "../plans/plan-store.js";
import { oneLine, planBriefLine } from "../../../shared/plan-text.js";

const ATTENTION_LIMIT = 30;
const FYI_LIMIT = 20;
const STALLED_LIMIT = 30;
/** Must match ManagerWorkItemHeartbeat's wake reason. */
const SWEEP_REASON = "work-item-heartbeat";

/** The manager's work-item wake context: what needs attention, what moved
 *  recently, and — on a sweep wake only — what stopped with nothing to wake
 *  it. Worker reports arrive as messages of their own, not here. */
export function buildWorkItemWakeSection(
  overviewThreadId: string,
  workStore: WorkItemStore,
  agentStore: AgentStore,
  planStore?: PlanStore,
  /** Whether a turn of the worker runs, as the feature index reads it. */
  workerRunning?: (featureId: string) => boolean
): string {
  /** A feature as its plan reads in one line; the title alone without a plan store. */
  const brief = (it: Pick<WorkItem, "featureId" | "title" | "failedAt" | "failedKind">) => {
    const plan = planStore?.get(it.featureId);
    const failure = it.failedAt ? { at: it.failedAt, kind: it.failedKind ?? "error" } : null;
    return { plan, line: plan ? planBriefLine(it.title, plan, failure, workerRunning?.(it.featureId) ?? false) : it.title };
  };
  // Fetch slightly over the limit so we can report the accurate overflow count.
  // For the attention section: use a large fetch to get exact overflow count
  // (realistic cap: ~few hundred pending items at most).
  // Only this thread's workers: another thread's are
  // not this thread's to direct. Unowned ones are anyone's.
  const owner = { ownerThreadId: overviewThreadId };
  // An archived worker is out of its hands: its last failure is not one.
  const flagged = workStore.listAttention({ ...owner, unarchivedOnly: true, limit: ATTENTION_LIMIT + 1000 });
  // A plan with open questions asks for an answer even when nothing flags its
  // feature: the manager answers what it can and forwards the rest.
  const flaggedFeatures = new Set(flagged.map((it) => it.featureId));
  const asking = (planStore?.listActive() ?? [])
    .filter((plan) => plan.openQuestions.length > 0 && !flaggedFeatures.has(plan.featureId))
    .filter((plan) => workStore.isOwnedBy(plan.featureId, overviewThreadId))
    .map((plan) => workStore.getByFeature(plan.featureId))
    .filter((it): it is NonNullable<typeof it> => it !== null)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const attentionRaw = [...flagged, ...asking];
  const attentionShown = attentionRaw.slice(0, ATTENTION_LIMIT);
  const attentionOverflow = Math.max(0, attentionRaw.length - ATTENTION_LIMIT);

  // The sweep is computed first because it also decides what FYI must not
  // repeat. A feature that stalled in the last 24h satisfies listIdle too, so
  // without this it would be listed twice — once as needing action, and once
  // under a heading that says no action is needed.
  const runningWake = agentStore.getRunningWakeForThread(overviewThreadId);
  const isSweep = runningWake?.reason === SWEEP_REASON
    || runningWake?.metadata?.recovery?.originalReason === SWEEP_REASON;
  const stalledAll = isSweep ? workStore.listStalled({ ...owner, limit: STALLED_LIMIT + 1000 }) : [];
  const stalledIds = new Set(stalledAll.map((it) => it.id));

  // Nor what is under attention: a list headed "no action needed" never
  // repeats one that needs it.
  const attentionIds = new Set(attentionRaw.map((it) => it.id));
  const fyiRaw = workStore
    .listIdle({ ...owner, limit: FYI_LIMIT + 1000 })
    .filter((it) => !stalledIds.has(it.id) && !attentionIds.has(it.id));
  const fyiShown = fyiRaw.slice(0, FYI_LIMIT);
  const fyiOverflow = Math.max(0, fyiRaw.length - FYI_LIMIT);

  const lines: string[] = [];

  // -----------------------------------------------------------------------
  // Section 1: Attention items
  // -----------------------------------------------------------------------
  lines.push("--- OPEN WORK ITEMS NEEDING ATTENTION ---");
  if (attentionShown.length === 0) {
    lines.push("(none)");
  } else {
    for (const it of attentionShown) {
      const { plan, line } = brief(it);
      const why = it.failedAt ? (it.failedKind === "stopped" ? "stopped" : "failed") : "open questions";
      lines.push(`[${it.id} · ${it.projectId}/${it.featureId} · ${why}]`);
      lines.push(`  ${line}`);
      if (plan && plan.openQuestions.length > 0) {
        lines.push("  Open questions:", ...plan.openQuestions.map((q) => `  - ${oneLine(q)}`));
      }
      lines.push(`  Last activity: ${it.lastActivityAt}`);
    }
    if (attentionOverflow > 0) {
      lines.push(`... and ${attentionOverflow} more attention items not shown`);
    }
  }

  // -----------------------------------------------------------------------
  // What this manager asked the user and has no answer to. A compaction can
  // take the asking out of its context; this is how it still knows, and
  // where it finds the id that takes a question back.
  // -----------------------------------------------------------------------
  lines.push("");
  lines.push("--- YOUR QUESTIONS TO THE USER (NOT ANSWERED YET) ---");
  const questions = agentStore.openQuestions(overviewThreadId);
  if (questions.length === 0) lines.push("(none)");
  else for (const q of questions) lines.push(`[${q.id}] ${oneLine(q.question)}`);

  // -----------------------------------------------------------------------
  // Section 2: FYI passive updates
  // -----------------------------------------------------------------------
  lines.push("");
  lines.push("--- RECENT PASSIVE UPDATES (FYI, no action needed) ---");
  if (fyiShown.length === 0) {
    lines.push("(none in last 24h)");
  } else {
    for (const it of fyiShown) {
      lines.push(`[${it.id} · ${it.projectId}/${it.featureId}] ${brief(it).line} (${it.lastActivityAt})`);
    }
    if (fyiOverflow > 0) {
      lines.push(`... and ${fyiOverflow} more passive items not shown`);
    }
  }

  // -----------------------------------------------------------------------
  // Section 2b: The sweep — only on the wake the sweep timer asked for
  // -----------------------------------------------------------------------
  // Gated on the reason because every other wake has its own errand. A user
  // message or a feature event arrives with something specific to do; handing
  // it the whole standing list as well is how a list stops being read.
  if (isSweep) {
    const stalledShown = stalledAll.slice(0, STALLED_LIMIT);
    const stalledOverflow = Math.max(0, stalledAll.length - STALLED_LIMIT);

    lines.push("");
    lines.push("--- SWEEP: NOT DONE, AND NOTHING WILL WAKE THESE ---");
    if (stalledShown.length === 0) {
      lines.push("(none)");
      lines.push(
        "Nothing is stalled. If nothing else is outstanding, call end_sweep — " +
        "you will be woken again when new work arrives."
      );
    } else {
      for (const it of stalledShown) {
        lines.push(`[${it.id} · ${it.projectId}/${it.featureId}] ${brief(it).line} — last activity ${it.lastActivityAt}`);
        lines.push("  no running wake · no pending alarm · no undelivered event · no window watch · no monitor");
      }
      if (stalledOverflow > 0) {
        lines.push(`... and ${stalledOverflow} more stalled items not shown`);
      }
      lines.push(
        "  Action guidance: for each — push it forward with feature_message_send, " +
        "or put it to the user with ask_user if you cannot. " +
        "When every one is handled and nothing is outstanding, call end_sweep. " +
        "Otherwise do nothing and you will be woken again to check."
      );
    }
  }

  return lines.join("\n");
}
