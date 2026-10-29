import { create } from "zustand";
import type { GlobalAgentDto, GlobalHandoffDto, HandoffState } from "@shared/api/global-agent";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";

interface GlobalAgentState {
  agent: GlobalAgentDto | null;
  handoffs: Map<string, GlobalHandoffDto>;
  setAgent(agent: GlobalAgentDto): void;
  upsertHandoff(handoff: GlobalHandoffDto): void;
  /** Reads these handoffs as they stand now: the page passes the ones its transcript shows. */
  loadHandoffs(ids: readonly string[]): Promise<void>;
  markSeen(seq: number): void;
  saveName(name: string): Promise<{ ok: true } | { error: string }>;
  /** Reads the agent as the server holds it now, for when an event may have
   *  been missed; a copy an event brought while the read was out stays. */
  refresh(): Promise<void>;
}

/** Later states first among copies stamped in the same millisecond. */
const STATE_RANK: Record<HandoffState, number> = { queued: 1, delivered: 2, waiting: 2, replied: 3, failed: 3 };

/** Whether `next` is at least as new as `held`: a handoff's updatedAt only
 *  moves forward, so a copy that answers late — a list read
 *  while an event was on its way — never undoes what came after it. */
function isNewer(next: GlobalHandoffDto, held: GlobalHandoffDto | undefined): boolean {
  if (!held) return true;
  if (next.updatedAt !== held.updatedAt) return next.updatedAt > held.updatedAt;
  return STATE_RANK[next.state] >= STATE_RANK[held.state];
}

const HANDOFF_READ_BATCH = 200;

/** One read of handoffs, merged under the ordering rule: a newer copy an
 *  event already brought stays. A read that failed changes nothing. */
async function readInto(set: (update: (state: GlobalAgentState) => Partial<GlobalAgentState>) => void, url: string): Promise<void> {
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) return;
  const body = await response.json() as { handoffs: GlobalHandoffDto[] };
  set((state) => {
    const next = new Map(state.handoffs);
    for (const h of body.handoffs) if (isNewer(h, next.get(h.id))) next.set(h.id, h);
    return { handoffs: next };
  });
}

/** The global agent: its state from the server's events,
 *  and the handoffs it made, by id. */
export const useGlobalAgentStore = create<GlobalAgentState>((set, get) => ({
  agent: null,
  refresh: async () => {
    const before = get().agent;
    const response = await fetch(api.agentGlobal).catch(() => null);
    const body = response?.ok ? await response.json().catch(() => null) as { agent?: GlobalAgentDto } | null : null;
    if (body?.agent && get().agent === before) set({ agent: body.agent });
  },
  handoffs: new Map(),
  setAgent: (agent) => set({ agent }),
  upsertHandoff: (handoff) => set((state) => {
    if (!isNewer(handoff, state.handoffs.get(handoff.id))) return {};
    const next = new Map(state.handoffs);
    next.set(handoff.id, handoff);
    return { handoffs: next };
  }),
  loadHandoffs: async (ids) => {
    // In batches the server answers whole (it reads at most 500 at a time).
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += HANDOFF_READ_BATCH) batches.push(ids.slice(i, i + HANDOFF_READ_BATCH));
    await Promise.all(batches.map((batch) => readInto(set, api.agentGlobalHandoffs(batch))));
  },
  markSeen: (seq) => {
    const agent = get().agent;
    if (agent) set({ agent: { ...agent, unread: false } });
    // The answer is not applied: the server publishes the agent's new state
    // on the event stream, in order with every other update, whereas an
    // answer that lands late would replace a newer one. A failed write leaves
    // the dot cleared here until the next update says otherwise.
    void fetch(api.agentGlobalSeen, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq })
    }).catch(() => { /* the next update corrects it */ });
  },
  saveName: async (name) => {
    try {
      const response = await fetch(api.settingsConfig, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { globalAgentName: name } })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        return { error: body.error ?? `HTTP ${response.status}` };
      }
      // The save re-publishes the agent to every tab; read it here too, so
      // this tab does not wait on its event stream to leave the guide — but
      // only if no update landed meanwhile, which would be newer than it.
      const before = get().agent;
      const state = await fetch(api.agentGlobal).catch(() => null);
      const body = state?.ok ? await state.json().catch(() => null) as { agent?: GlobalAgentDto } | null : null;
      if (body?.agent && get().agent === before) set({ agent: body.agent });
      return { ok: true };
    } catch (err) {
      return { error: errorText(err) };
    }
  }
}));
