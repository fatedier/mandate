import { create } from "zustand";
import type { AgentActiveWakeDto, ModelRefDto } from "@shared/api-contracts";

/** The model each running wake calls now, heard over SSE (agentWakeModel) or
 *  read with the running wake (activeWake.model), for the composer's model
 *  name. Dropped when the wake finishes, and all on a reconnect. Bounded, so
 *  wakes whose finish was missed cannot pile up. */
const KEEP = 20;

interface WakeModelState {
  byWake: Map<string, ModelRefDto>;
  /** How many models the stream has told: a read begun at a lower count
   *  does not overwrite what the stream told since. */
  told: number;
  toldAt: Map<string, number>;
  /** How many reads have begun: of two reads, the later begun wins. */
  reads: number;
  readAt: Map<string, number>;
  /** As the stream tells it. */
  set(wakeId: string, model: ModelRefDto): void;
  /** As a read found it (`at`: where the counts stood as it began). */
  hydrate(wakeId: string, model: ModelRefDto, at: WakeModelReadMark): void;
  /** A read about to begin: where the counts stand. */
  beginRead(): WakeModelReadMark;
  clear(wakeId: string): void;
  /** On a reconnect: a wake that finished while the stream was down never said so. */
  clearAll(): void;
}

function withModel(byWake: Map<string, ModelRefDto>, wakeId: string, model: ModelRefDto): Map<string, ModelRefDto> {
  const next = new Map(byWake);
  next.delete(wakeId);
  next.set(wakeId, model);
  while (next.size > KEEP) next.delete(next.keys().next().value!);
  return next;
}

/** Where the counts stood as a read began. */
export interface WakeModelReadMark { told: number; read: number }

function withMark(marks: Map<string, number>, wakeId: string, mark: number): Map<string, number> {
  const next = new Map(marks);
  next.delete(wakeId);
  next.set(wakeId, mark);
  while (next.size > KEEP) next.delete(next.keys().next().value!);
  return next;
}

export const useWakeModelStore = create<WakeModelState>((set, get) => ({
  byWake: new Map(),
  told: 0,
  toldAt: new Map(),
  reads: 0,
  readAt: new Map(),
  beginRead: () => {
    const read = get().reads + 1;
    set({ reads: read });
    return { told: get().told, read };
  },
  set: (wakeId, model) => set((state) => {
    const told = state.told + 1;
    const toldAt = withMark(state.toldAt, wakeId, told);
    if (state.byWake.get(wakeId)?.ref === model.ref) return { told, toldAt };
    return { told, toldAt, byWake: withModel(state.byWake, wakeId, model) };
  }),
  hydrate: (wakeId, model, at) => set((state) => {
    // The stream told this wake's model after the read began, or a read
    // begun later already answered: what this one found is older.
    if ((state.toldAt.get(wakeId) ?? 0) > at.told || (state.readAt.get(wakeId) ?? 0) > at.read) return state;
    const readAt = withMark(state.readAt, wakeId, at.read);
    if (state.byWake.get(wakeId)?.ref === model.ref) return { readAt };
    return { readAt, byWake: withModel(state.byWake, wakeId, model) };
  }),
  clear: (wakeId) => set((state) => {
    if (!state.byWake.has(wakeId)) return state;
    const byWake = new Map(state.byWake);
    byWake.delete(wakeId);
    return { byWake };
  }),
  clearAll: () => set((state) => (state.byWake.size === 0 ? state : { byWake: new Map() }))
}));

/** A thread read about to begin: its mark, which it hands back with what it found. */
export function beginWakeModelRead(): WakeModelReadMark {
  return useWakeModelStore.getState().beginRead();
}

/** A thread read's running wake: its model, when it says one, unless the
 *  stream told that wake's model after the read began or a later read
 *  already answered. */
export function noteActiveWakeModel(activeWake: AgentActiveWakeDto | null | undefined, at: WakeModelReadMark): void {
  if (activeWake?.model) useWakeModelStore.getState().hydrate(activeWake.wakeId, activeWake.model, at);
}
