import type { ReconcileTmux } from "./project-reconcile.js";
import {
  type TmuxClient,
  tmuxHasSession, tmuxNewSession,
  tmuxHasWindow, tmuxNewWindow
} from "../../platform/tmux/tmux.js";

/** Adapts our spawnSync-based tmux primitives to the pure ReconcileTmux interface. */
export function tmuxReconcileAdapter(client: TmuxClient): ReconcileTmux {
  return {
    hasSession: (name) => tmuxHasSession(name, client),
    newSession: (name, cwd) => tmuxNewSession(name, cwd, client),
    hasWindow: (session, win) => tmuxHasWindow(session, win, client),
    newWindow: (session, win, cwd) => tmuxNewWindow(session, win, cwd, client)
  };
}

/** The same adapter, remembering the windows it opened: a create or restore
 *  that fails afterwards closes the one it opened for its own worker (a
 *  session rebuilt on the way also reopens the other workers' windows, which
 *  stay), so the same request can be made again. */
export function recordingReconcileAdapter(base: ReconcileTmux): { adapter: ReconcileTmux; opened: OpenedWindow[] } {
  const opened: OpenedWindow[] = [];
  return {
    opened,
    adapter: {
      ...base,
      newWindow: (session, win, cwd) => {
        const id = base.newWindow(session, win, cwd);
        if (typeof id === "string" && id) opened.push({ window: win, id });
        return id;
      }
    }
  };
}

/** A window an attempt opened: closed by its id, never by name. */
export interface OpenedWindow {
  window: string;
  id: string;
}
