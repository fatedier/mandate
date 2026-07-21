import type { WorkItemStore } from "./work-item-store.js";
import type { AgentStore, MailboxEventRow } from "./agent-store.js";

const ATTENTION_LIMIT = 30;
const FYI_LIMIT = 20;
const EVENT_LIMIT = 50;
const STALLED_LIMIT = 30;
/** Must match ManagerWorkItemHeartbeat's wake reason. */
const SWEEP_REASON = "work-item-heartbeat";

interface WorkItemWakeSection {
  text: string;
  processedEventIds: string[];
}

/** Build the three-section work-item wake context block for the overview agent.
 *
 *  Returns:
 *  - `text`: formatted string to inject into the runtime_context user message
 *  - `processedEventIds`: mailbox row IDs to mark delivered after LLM succeeds
 *
 *  Callers MUST call agentStore.markFeatureEventsProcessed(processedEventIds)
 *  only after the LLM turn completes successfully — never if the wake errors
 *  or is canceled. */
export function buildWorkItemWakeSection(
  overviewThreadId: string,
  workStore: WorkItemStore,
  agentStore: AgentStore
): WorkItemWakeSection {
  // Fetch slightly over the limit so we can report the accurate overflow count.
  // For the attention section: use a large fetch to get exact overflow count
  // (realistic cap: ~few hundred pending items at most).
  const attentionRaw = workStore.listAttention({ limit: ATTENTION_LIMIT + 1000 });
  const attentionShown = attentionRaw.slice(0, ATTENTION_LIMIT);
  const attentionOverflow = Math.max(0, attentionRaw.length - ATTENTION_LIMIT);

  // The sweep is computed first because it also decides what FYI must not
  // repeat. A feature that stalled in the last 24h satisfies listIdle too, so
  // without this it would be listed twice — once as needing action, and once
  // under a heading that says no action is needed.
  const runningWake = agentStore.getRunningWakeForThread(overviewThreadId);
  const isSweep = runningWake?.reason === SWEEP_REASON
    || runningWake?.metadata?.recovery?.originalReason === SWEEP_REASON;
  const stalledAll = isSweep ? workStore.listStalled({ limit: STALLED_LIMIT + 1000 }) : [];
  const stalledIds = new Set(stalledAll.map((it) => it.id));

  const fyiRaw = workStore
    .listIdle({ limit: FYI_LIMIT + 1000 })
    .filter((it) => !stalledIds.has(it.id));
  const fyiShown = fyiRaw.slice(0, FYI_LIMIT);
  const fyiOverflow = Math.max(0, fyiRaw.length - FYI_LIMIT);

  const events: MailboxEventRow[] = agentStore.listPendingFeatureEvents(
    overviewThreadId,
    EVENT_LIMIT
  );

  const lines: string[] = [];

  // -----------------------------------------------------------------------
  // Section 1: Attention items
  // -----------------------------------------------------------------------
  lines.push("--- OPEN WORK ITEMS NEEDING ATTENTION ---");
  if (attentionShown.length === 0) {
    lines.push("(none)");
  } else {
    for (const it of attentionShown) {
      lines.push(
        `[${it.id} · ${it.projectId}/${it.featureId} · needsUser=${it.needsUser} · phase=${it.phase}]`
      );
      lines.push(`  Title: ${it.title}`);
      lines.push(`  Last activity: ${it.lastActivityAt}`);
      if (it.phaseDetail) {
        lines.push(`  Feature note: "${it.phaseDetail}"`);
      }
    }
    if (attentionOverflow > 0) {
      lines.push(`... and ${attentionOverflow} more attention items not shown`);
    }
  }

  // -----------------------------------------------------------------------
  // Section 2: FYI passive updates
  // -----------------------------------------------------------------------
  lines.push("");
  lines.push("--- RECENT PASSIVE UPDATES (FYI, no action needed) ---");
  if (fyiShown.length === 0) {
    lines.push("(none in last 24h)");
  } else {
    for (const it of fyiShown) {
      const detail = it.phaseDetail ?? "(no detail)";
      lines.push(
        `[${it.id} · ${it.projectId}/${it.featureId} · phase=${it.phase}] ${detail} (${it.lastActivityAt})`
      );
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
        lines.push(
          `[${it.id} · ${it.projectId}/${it.featureId} · phase=${it.phase}] ` +
          `last activity ${it.lastActivityAt}`
        );
        lines.push("  no running wake · no pending alarm · no undelivered event · no window watch");
      }
      if (stalledOverflow > 0) {
        lines.push(`... and ${stalledOverflow} more stalled items not shown`);
      }
      lines.push(
        "  Action guidance: for each — push it forward with feature_message_send, " +
        "or set needs_user if you cannot, or mark it done if it is finished. " +
        "When every one is handled and nothing is outstanding, call end_sweep. " +
        "Otherwise do nothing and you will be woken again to check."
      );
    }
  }

  // -----------------------------------------------------------------------
  // Section 3: Incoming feature events this wake
  // -----------------------------------------------------------------------
  lines.push("");
  lines.push("--- INCOMING FEATURE EVENTS THIS WAKE ---");
  if (events.length === 0) {
    lines.push("(none)");
  } else {
    for (const e of events) {
      const c = e.content;
      const wiId = c.workItemId ?? c.source?.workItem?.id ?? "—";
      const sourceLabel = featureEventSourceLabel(c);
      const summary = c.summary.length > 300
        ? `${c.summary.slice(0, 299)}…`
        : c.summary;
      if (c.kind === "limit_reached") {
        lines.push(
          `[${wiId} · ${sourceLabel} · kind=limit_reached stepCount=${c.stepCount}] ${c.label}: "${summary}"`
        );
        lines.push(
          "  Action guidance: decide whether to continue, pause, ask the user, or stop. " +
          "This is a feature-level wake limit, not a specific task status change. " +
          "If continuing is useful, send a fresh concise instruction with feature_message_send."
        );
      } else if (c.kind === "completion") {
        lines.push(
          `[${wiId} · ${sourceLabel} · kind=completion · task=${c.taskId}] ${c.label}: "${summary}"`
        );
      } else {
        lines.push(
          `[${wiId} · ${sourceLabel} · kind=escalation signal=${c.signal ?? "blocked"} · task=${c.taskId}] ` +
          `${c.label}: "${summary}"`
        );
      }
    }
  }

  return {
    text: lines.join("\n"),
    processedEventIds: events.map((e) => e.id)
  };
}

function featureEventSourceLabel(content: MailboxEventRow["content"]): string {
  const project = content.source?.project?.name
    ?? content.source?.project?.id
    ?? "unknown project";
  const feature = content.source?.feature.name
    ?? content.source?.feature.id
    ?? content.featureId;
  return `${project}/${feature}`;
}
