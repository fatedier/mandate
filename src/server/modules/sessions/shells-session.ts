import { projectSessionHashForDataDir } from "../../platform/naming/names.js";
import { commandFailureMessage } from "../../platform/process/command-runner.js";
import { tmuxCommand, tmuxHasSession, tmuxNewSession, type TmuxClient } from "../../platform/tmux/tmux.js";

const PANE_FORMAT = "#{pane_id} #{pane_pid}";

/** The one tmux session the Terminals page's new shells open in, per data
 *  directory. It cannot be a project's: those are `md-<name>-<hash>`. */
export function shellsSessionName(dataDir: string): string {
  return `mandate-shells-${projectSessionHashForDataDir(dataDir)}`;
}

export interface OpenShellDeps {
  tmuxClient: TmuxClient;
  dataDir: string;
  homeDir: string;
}

/** A new shell in the home folder: the shells session's first pane when the
 *  session has to be made, else a new window in it, named as tmux names it. */
export async function openShell(deps: OpenShellDeps): Promise<{ paneId: string; pid: number }> {
  const session = shellsSessionName(deps.dataDir);
  // "=": this exact session; tmux would otherwise take one whose name only
  // starts with it.
  const exact = `=${session}`;
  if (!(await tmuxHasSession(exact, deps.tmuxClient))) {
    try {
      await tmuxNewSession(session, deps.homeDir, deps.tmuxClient);
      const r = await tmuxCommand(deps.tmuxClient, ["list-panes", "-t", exact, "-F", PANE_FORMAT], { timeout: 1500 });
      if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux list-panes failed (status ${r.status})`));
      return parsePane(r.stdout);
    } catch (error) {
      // Made meanwhile by another New terminal: a window in it, as below.
      if (!(await tmuxHasSession(exact, deps.tmuxClient))) throw error;
    }
  }
  const r = await tmuxCommand(
    deps.tmuxClient,
    ["new-window", "-d", "-P", "-F", PANE_FORMAT, "-t", `${exact}:`, "-c", deps.homeDir],
    { timeout: 2500 }
  );
  if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux new-window failed (status ${r.status})`));
  return parsePane(r.stdout);
}

function parsePane(stdout: string): { paneId: string; pid: number } {
  const [paneId, pid] = (stdout.split("\n")[0] ?? "").trim().split(" ");
  if (!paneId?.startsWith("%") || !Number(pid)) throw new Error(`tmux gave no pane: ${stdout.trim() || "(nothing)"}`);
  return { paneId, pid: Number(pid) };
}
