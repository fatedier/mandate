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
