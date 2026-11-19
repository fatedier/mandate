import type { Hono } from "hono";
import { API_ROUTES, SSE_EVENTS, type NewTerminalResponse, type TerminalPinsResponse, type TerminalsResponse } from "../../../shared/api-contracts.js";
import { errorText } from "../../../shared/error-text.js";
import { isRecord } from "../../../shared/guards.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";
import { tmuxLivePanes, type TmuxClient } from "../../platform/tmux/tmux.js";
import type { RawTmuxState } from "../../platform/tmux/tmux-types.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { SessionService } from "./session-service.js";
import type { TerminalPinStore } from "./terminal-pins-store.js";

export interface TerminalRoutesDeps {
  sessions: SessionService;
  pins: TerminalPinStore;
  sse: Pick<AgentSseEmitter, "emit">;
  /** Asked which panes are live before pins are judged gone: the last poll
   *  can be seconds old, or empty because its listing failed. */
  tmuxClient: TmuxClient;
  /** The last tmux poll: the panes a user can see in All, and pin. */
  getRawState: () => RawTmuxState | null;
  /** A new shell in Mandate's shells session. */
  openShell: () => Promise<{ paneId: string; pid: number }>;
  /** Polls tmux now, so the new shell is in the state the next reads see. */
  refreshState: () => Promise<void>;
}

export function mountTerminalRoutes(app: Hono, deps: TerminalRoutesDeps): void {
  const polled = () => deps.getRawState()?.panes.map((p) => ({ paneId: p.paneId, pid: Number(p.panePid) })) ?? null;
  const changed = () => deps.sse.emit(SSE_EVENTS.terminalPinsChanged, {});

  app.get(API_ROUTES.terminals, async (c) => {
    // Judged against tmux as asked below: a pin made while it answers stays.
    const before = deps.pins.list();
    const sessions = await deps.sessions.listSessions();
    const live = await tmuxLivePanes(deps.tmuxClient);
    if (live && deps.pins.dropMissing(live, before) > 0) changed();
    return c.json({ sessions, pins: deps.pins.list() } satisfies TerminalsResponse);
  });

  app.post(API_ROUTES.terminals, async (c) => {
    let shell: { paneId: string; pid: number };
    try {
      shell = await deps.openShell();
    } catch (err: unknown) {
      return c.json({ error: errorText(err, "could not open a shell") } satisfies NewTerminalResponse, 500);
    }
    await deps.refreshState().catch(() => {});
    return c.json(shell satisfies NewTerminalResponse);
  });

  app.post(API_ROUTES.terminalPins, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON || !isRecord(body)) return c.json({ error: "invalid JSON" } satisfies TerminalPinsResponse, 400);
    const { paneId, pid } = body;
    if (typeof paneId !== "string" || typeof pid !== "number") {
      return c.json({ error: "paneId must be a string and pid a number" } satisfies TerminalPinsResponse, 400);
    }
    if (!polled()?.some((p) => p.paneId === paneId && p.pid === pid)) {
      return c.json({ error: "pane not found" } satisfies TerminalPinsResponse, 404);
    }
    if (deps.pins.add(paneId, pid)) changed();
    return c.json({ pins: deps.pins.list() } satisfies TerminalPinsResponse);
  });

  app.put(API_ROUTES.terminalPinsOrder, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON || !isRecord(body)) return c.json({ error: "invalid JSON" } satisfies TerminalPinsResponse, 400);
    const order = body.pins;
    if (!Array.isArray(order) || !order.every((p) => isRecord(p) && typeof p.paneId === "string" && typeof p.pid === "number")) {
      return c.json({ error: "pins must be a list of { paneId, pid }" } satisfies TerminalPinsResponse, 400);
    }
    if (deps.pins.reorder(order as Array<{ paneId: string; pid: number }>)) changed();
    return c.json({ pins: deps.pins.list() } satisfies TerminalPinsResponse);
  });

  app.delete(API_ROUTES.terminalPin, (c) => {
    if (!deps.pins.remove(c.req.param("paneId"))) return c.json({ error: "pin not found" } satisfies TerminalPinsResponse, 404);
    changed();
    return c.json({ pins: deps.pins.list() } satisfies TerminalPinsResponse);
  });
}
