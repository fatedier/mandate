import type { Config } from "../../config.js";
import { logError } from "../../platform/logger.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS, type SseEvent } from "../../../shared/api-contracts.js";
import type { AgentWakeErrorCategory } from "../../../shared/api/agents.js";
import type { ThreadStatusSnapshotDto, WaitingEntryDto } from "../../../shared/api/thread-status.js";
import { displayPersonalAgentName } from "../../../shared/personal-agent-name.js";
import type { NotificationService, NotifyRequest } from "./notification-service.js";
import { AGENT_HELD_KEY, AGENT_QUESTION_KEY, isAgentHeld, isAgentQuestion, listsMatter } from "./waiting-match.js";

/** A failure on the model's side: the personal agent could not reach its model. */
const PROVIDER_CATEGORIES: ReadonlySet<AgentWakeErrorCategory> = new Set(["provider_overloaded", "rate_limited", "timeout", "provider_error", "auth_failed"]);

/** How long a failure waits for the list that may show something waiting
 *  (the status is sent at most every 250 ms). */
const LIST_LAG_MS = 2_000;

const QUESTION = AGENT_QUESTION_KEY;
const HELD = AGENT_HELD_KEY;
const FAILED = "agent:failed";

/**
 * The system's own notices, for when the personal agent is the one stuck:
 * its question to the user, its calls held back again and again, a turn of
 * its that failed or stopped. And the settling of matters: a notice about a
 * thread or worker is taken back once nothing of it waits on the user.
 *
 * Reads the status the server already broadcasts. What waits when it starts
 * is taken as told: a restart sends nothing again.
 */
export function startNotificationWatch(deps: {
  sse: Pick<AgentSseEmitter, "addSink">;
  service: Pick<NotificationService, "notify" | "settle" | "isOn" | "openMatterKeys">;
  agentStore: Pick<AgentStore, "getWakeById">;
  getConfig: () => Pick<Config, "agent">;
  /** What waits now, read once at the start. */
  current?: () => ThreadStatusSnapshotDto | null;
}): () => void {
  let waiting: readonly WaitingEntryDto[] = deps.current?.()?.waiting ?? [];
  const told = new Set<string>([
    ...(waiting.some(isAgentQuestion) ? [QUESTION] : []),
    ...(waiting.some(isAgentHeld) ? [HELD] : [])
  ]);
  const name = () => displayPersonalAgentName(deps.getConfig().agent.personalAgentName);
  const send = (request: Omit<NotifyRequest, "source" | "level">) => {
    deps.service.notify({ source: "system", level: "needs_you", ...request }).catch((err: unknown) => logError("notifications-safety-net", err));
  };
  const settle = (key: string) => {
    deps.service.settle(key).catch((err: unknown) => logError("notifications-settle", err));
  };
  /** A turn of the personal agent that failed when nothing was listed as waiting
   *  yet: the list may lag the failure (it is sent at most every 250 ms), so
   *  the next list decides. */
  let failedBeforeList: { reason: string; unreachable: boolean; at: number } | null = null;
  const sendFailure = (failure: { reason: string; unreachable: boolean }) => {
    told.add(FAILED);
    send({
      matter: { key: FAILED, link: "/agent" },
      title: failure.unreachable ? `${name()} can't reach its model` : `${name()} stopped`,
      text: withCount(failure.reason, waiting.length)
    });
  };

  const onStatus = (snapshot: ThreadStatusSnapshotDto) => {
    const previous = waiting;
    waiting = snapshot.waiting;
    if (failedBeforeList) {
      const failure = failedBeforeList;
      failedBeforeList = null;
      const fresh = Date.now() - failure.at <= LIST_LAG_MS;
      if (fresh && waiting.length > 0 && deps.service.isOn()) sendFailure(failure);
    }
    for (const [key, has, notice] of [
      [QUESTION, isAgentQuestion, (e: WaitingEntryDto) => ({ title: `${name()} asks`, text: e.text })],
      [HELD, isAgentHeld, (e: WaitingEntryDto) => ({ title: `${name()} stopped`, text: withCount(e.text, waiting.length) })]
    ] as const) {
      const now = waiting.find(has);
      if (now && !told.has(key)) {
        told.add(key);
        if (deps.service.isOn()) send({ matter: { key, link: "/agent" }, ...notice(now) });
      } else if (!now && told.has(key)) {
        told.delete(key);
        settle(key);
      }
    }
    // A notice about a thread or worker that was listed (before or now) and
    // no longer is: its matter no longer waits on the user.
    for (const key of deps.service.openMatterKeys()) {
      if (!key.startsWith("thread:") && !key.startsWith("worker:")) continue;
      if (listsMatter(previous, key) && !listsMatter(waiting, key)) settle(key);
    }
  };

  const onWakeFinished = (data: SseEvent & { event: typeof SSE_EVENTS.agentWakeFinished } extends { data: infer D } ? D : never) => {
    if (data.scope !== "personal") return;
    if (data.status === "finished") {
      failedBeforeList = null;
      // A notice of an earlier failure, this run's or one before a restart.
      if (told.delete(FAILED) || deps.service.openMatterKeys().includes(FAILED)) settle(FAILED);
      return;
    }
    if (data.status !== "error" && data.status !== "stuck") return;
    const failure = {
      reason: data.error?.message?.trim() || data.errorMessage?.trim() || "Its turn did not finish",
      unreachable: data.error ? PROVIDER_CATEGORIES.has(data.error.category) : false
    };
    const startedByUser = deps.agentStore.getWakeById(data.wakeId)?.reason === "user";
    if (!startedByUser && waiting.length === 0) {
      failedBeforeList = { ...failure, at: Date.now() };
      return;
    }
    if (deps.service.isOn()) sendFailure(failure);
  };

  return deps.sse.addSink((e) => {
    // After the sink returns, as the other broadcasts do.
    if (e.event === SSE_EVENTS.threadStatus) {
      const snapshot = e.data;
      queueMicrotask(() => onStatus(snapshot));
    } else if (e.event === SSE_EVENTS.agentWakeFinished) {
      const data = e.data;
      queueMicrotask(() => onWakeFinished(data));
    }
  });
}

/** The reason, then how much waits on the user; nothing said when nothing does. */
function withCount(reason: string, count: number): string {
  const said = reason.replace(/[.\s]+$/, "");
  if (count === 0) return `${said}.`;
  return `${said}. ${count === 1 ? "1 thing waits on you." : `${count} things wait on you.`}`;
}
