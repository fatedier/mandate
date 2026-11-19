import { useEffect } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { api } from "@/lib/api-paths";
import type { NewTerminalResponse, SessionDto, TerminalPinDto, TerminalPinsResponse, TerminalsResponse } from "@shared/api-contracts";

/** Every tmux session and the pins, as the server has them: read on the
 *  Terminals page every few seconds, and at once when another device pins or
 *  unpins (terminalPinsChanged). Every request takes a ticket. A list is kept
 *  only over an older list. Pins come from a pin or unpin's own answer; a
 *  list read that overlapped one (the server may have answered it on either
 *  side of the change) keeps its sessions, not its pins, and the list is read
 *  again once no change is on its way. */
interface TerminalsState {
  /** Null until the first list arrives. */
  sessions: SessionDto[] | null;
  pins: TerminalPinDto[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  latest: number;
  /** The ticket of the pins shown. */
  applied: number;
  /** The ticket of the sessions shown. */
  listApplied: number;
  refresh(): Promise<void>;
  pin(paneId: string, pid: number): Promise<void>;
  unpin(paneId: string): Promise<void>;
  /** The pins in the order a drag (or Move) put them in: shown at once,
   *  then saved; refused, the pins are read again. */
  reorderPins(order: Array<{ paneId: string; pid: number }>): Promise<void>;
  /** A new shell's pane, or null after saying why there is none. */
  openShell(): Promise<{ paneId: string; pid: number } | null>;
  /** The pins may have changed: read again, if the list was ever read. */
  changed(): void;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

const reason = (body: { error?: string } | null, res: Response) => body?.error ?? `HTTP ${res.status}`;

export const useTerminalsStore = create<TerminalsState>((set, get) => {
  // Pin and unpin requests on their way, the last one's ticket, and whether a
  // list read's pins were set aside meanwhile.
  let changing = 0;
  // Pin orders are saved one after another: two quick moves sent at once
  // could reach the server the other way round, the older order kept.
  let saving: Promise<unknown> = Promise.resolve();
  let lastChange = 0;
  let setAside = false;
  const ticket = () => {
    const next = get().latest + 1;
    set({ latest: next });
    return next;
  };
  // The pins as of ticket `at`, unless newer ones are shown. A reorder's
  // save answers under the ticket its order was shown with: equal is the
  // server's word on that order (a pin another device took away goes).
  const applyPins = (at: number, pins: TerminalPinDto[]) =>
    set((state) => (at < state.applied ? state : { pins, applied: at }));

  /** Whether the server took the change. `shown`, the ticket of the pins
   *  the change already shows (a reorder's, saved later in turn): its
   *  answer is no newer than that. */
  const changePins = async (url: string, init: RequestInit, failed: string, shown?: number): Promise<boolean> => {
    const at = shown ?? ticket();
    changing += 1;
    lastChange = at;
    try {
      const res = await fetch(url, init);
      const body = await readJson<TerminalPinsResponse>(res);
      if (!res.ok || !body || !("pins" in body)) throw new Error(reason(body as { error?: string } | null, res));
      applyPins(at, body.pins);
      return true;
    } catch (err: unknown) {
      toast.error(failed, { description: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      changing -= 1;
      settled();
    }
  };
  // Nothing on its way any more (queued pin orders count from when they are
  // queued): a list read set aside meanwhile is made good now.
  const settled = () => {
    if (changing === 0 && setAside) {
      setAside = false;
      void get().refresh();
    }
  };

  return {
    sessions: null,
    pins: [],
    status: "idle",
    error: null,
    latest: 0,
    applied: 0,
    listApplied: 0,
    refresh: async () => {
      const at = ticket();
      // Sent while a change was on its way: the server may answer it from
      // either side of that change, whichever comes back first.
      const overlapped = changing > 0;
      if (get().sessions === null) set({ status: "loading" });
      try {
        const res = await fetch(api.terminals);
        const body = await readJson<TerminalsResponse>(res);
        if (!res.ok || !body || !("sessions" in body)) throw new Error(reason(body as { error?: string } | null, res));
        set((state) => (at <= state.listApplied ? state : { sessions: body.sessions, status: "ready", error: null, listApplied: at }));
        if (changing > 0) setAside = true;
        // A change sent or answered while this read was out: read again.
        else if (overlapped || lastChange > at) void get().refresh();
        else applyPins(at, body.pins);
      } catch (err: unknown) {
        // What is shown stays; the next read tries again.
        if (get().sessions === null) set({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },
    pin: async (paneId, pid) => { await changePins(api.terminalPins, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paneId, pid })
    }, "Couldn't pin this terminal."); },
    unpin: async (paneId) => { await changePins(api.terminalPin(paneId), { method: "DELETE" }, "Couldn't unpin this terminal."); },
    reorderPins: async (order) => {
      const pins = get().pins;
      const listed = order.flatMap((o) => pins.filter((p) => p.paneId === o.paneId && p.pid === o.pid));
      // Shown at once, under a ticket of its own: a list read sent before
      // it does not put the old order back, nor an earlier save's answer.
      const shown = ticket();
      applyPins(shown, [...listed, ...pins.filter((p) => !listed.includes(p))]);
      const body = JSON.stringify({ pins: order.map(({ paneId, pid }) => ({ paneId, pid })) });
      // On its way from now, though it waits for the saves before it.
      changing += 1;
      lastChange = shown;
      const save = saving.then(() => changePins(api.terminalPinsOrder, { method: "PUT", headers: { "content-type": "application/json" }, body }, "Couldn't move this terminal.", shown));
      saving = save;
      const saved = await save;
      changing -= 1;
      if (!saved) setAside = true;
      settled();
    },
    openShell: async () => {
      try {
        const res = await fetch(api.terminals, { method: "POST" });
        const body = await readJson<NewTerminalResponse>(res);
        if (!res.ok || !body || !("paneId" in body)) throw new Error(reason(body as { error?: string } | null, res));
        void get().refresh();
        return { paneId: body.paneId, pid: body.pid };
      } catch (err: unknown) {
        toast.error("Couldn't open a new terminal.", { description: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
    changed: () => {
      if (get().latest > 0) void get().refresh();
    }
  };
});

/** Reads the list unless one has arrived or is on its way: a first read that
 *  failed is tried again by the next place that needs it. */
export function readTerminalsIfNeeded(): void {
  const { sessions, status, refresh } = useTerminalsStore.getState();
  if (sessions === null && status !== "loading") void refresh();
}

export const TERMINALS_POLL_MS = 5000;

/** Reads now, then every `every` tick while the page is visible; returns stop. */
export function startTerminalsPolling(deps: {
  read: () => void;
  visible: () => boolean;
  every: (fn: () => void) => () => void;
}): () => void {
  deps.read();
  return deps.every(() => {
    if (deps.visible()) deps.read();
  });
}

/** The Terminals page's polling: every 5 s while visible, and at once when it
 *  becomes visible again. */
/** `enabled` false (a page kept running hidden, KeptAlivePage): no reads
 *  until it is true again. */
export function useTerminalsPolling(enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const read = () => { void useTerminalsStore.getState().refresh(); };
    const visible = () => document.visibilityState === "visible";
    const stop = startTerminalsPolling({
      read,
      visible,
      every: (fn) => {
        const id = setInterval(fn, TERMINALS_POLL_MS);
        return () => clearInterval(id);
      }
    });
    const onVisible = () => { if (visible()) read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}
