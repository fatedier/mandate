import { FIELD_SEP } from "../text/text.js";
import {
  commandFailureMessage,
  nodeCommandRunner,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  commandDidNotAnswer,
  CommandDidNotAnswerError
} from "../process/command-runner.js";

export interface TmuxClient {
  /** Extra args inserted before any subcommand. e.g. ["-L", "test-123"] for an isolated test server. */
  socketArgs: string[];
  /** Command runner abstraction for tests and alternate tmux execution backends. */
  runner?: CommandRunner;
}

export const DEFAULT_TMUX: TmuxClient = { socketArgs: [] };

/** tmux without holding the server's thread while it runs. */
export function tmuxCommand(
  client: TmuxClient,
  args: string[],
  options?: CommandRunOptions
): Promise<CommandResult> {
  return (client.runner ?? nodeCommandRunner).run("tmux", [...client.socketArgs, ...args], options);
}

export async function tmuxHasSession(name: string, client: TmuxClient = DEFAULT_TMUX): Promise<boolean> {
  const r = await tmuxCommand(client, ["has-session", "-t", name], { timeout: 1500 });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux has-session");
  return r.status === 0;
}

export async function tmuxNewSession(name: string, cwd: string, client: TmuxClient = DEFAULT_TMUX): Promise<void> {
  const r = await tmuxCommand(client, ["new-session", "-d", "-s", name, "-c", cwd], { timeout: 2500 });
  if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux new-session failed (status ${r.status})`));
}

export async function tmuxKillSession(name: string, client: TmuxClient = DEFAULT_TMUX): Promise<void> {
  await tmuxCommand(client, ["kill-session", "-t", name], { timeout: 1500 });
}

export async function tmuxListSessions(client: TmuxClient = DEFAULT_TMUX): Promise<string[]> {
  const r = await tmuxCommand(client, ["list-sessions", "-F", "#{session_name}"], { timeout: 1500 });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-sessions");
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function tmuxHasWindow(session: string, windowName: string, client: TmuxClient = DEFAULT_TMUX): Promise<boolean> {
  const windows = await tmuxListWindows(session, client);
  return windows.includes(windowName);
}

export async function tmuxListWindows(session: string, client: TmuxClient = DEFAULT_TMUX): Promise<string[]> {
  const r = await tmuxCommand(client, ["list-windows", "-t", session, "-F", "#{window_name}"], { timeout: 1500 });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-windows");
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Opens a window and returns its id (`@N`): the one target that names it
 *  and nothing else. */
export async function tmuxNewWindow(session: string, windowName: string, cwd: string, client: TmuxClient = DEFAULT_TMUX): Promise<string> {
  const r = await tmuxCommand(
    client,
    ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", session, "-n", windowName, "-c", cwd],
    { timeout: 2500 }
  );
  if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux new-window failed (status ${r.status})`));
  return String(r.stdout || "").trim();
}

/** Closes the session's windows named exactly `windowName`, by id: tmux reads
 *  `session:1` as the window at index 1 before one named "1" (tmux 3.7c), so a
 *  worker named "1" would close another worker's window. */
export async function tmuxKillWindow(session: string, windowName: string, client: TmuxClient = DEFAULT_TMUX): Promise<void> {
  const r = await tmuxCommand(client, ["list-windows", "-t", session, "-F", `#{window_id}${FIELD_SEP}#{window_name}`], {
    timeout: 1500
  });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-windows");
  if (r.status !== 0) throw new Error(`tmux kill-window failed: ${r.stderr || r.stdout}`);
  const ids = r.stdout.split("\n").flatMap((line) => {
    const [id, name] = line.trim().split(FIELD_SEP);
    return id && name === windowName ? [id] : [];
  });
  if (ids.length === 0) throw new Error(`tmux kill-window failed: can't find window: ${session}:${windowName}`);
  for (const id of ids) await tmuxKillWindowById(id, client);
}

export async function tmuxKillWindowById(windowId: string, client: TmuxClient = DEFAULT_TMUX): Promise<void> {
  const r = await tmuxCommand(client, ["kill-window", "-t", windowId], { timeout: 1500 });
  if (r.status !== 0) throw new Error(`tmux kill-window failed: ${r.stderr || r.stdout}`);
}

interface TmuxSplitResult {
  paneId: string;
}

export async function tmuxSplitPane(
  paneId: string,
  direction: "right" | "down",
  client: TmuxClient = DEFAULT_TMUX,
  options: { cwd?: string | null } = {}
): Promise<TmuxSplitResult> {
  const flag = direction === "right" ? "-h" : "-v";
  const args = ["split-window", flag, "-t", paneId];
  if (options.cwd) args.push("-c", options.cwd);
  args.push("-P", "-F", "#{pane_id}");
  const r = await tmuxCommand(client, args, { timeout: 2500 });
  if (r.status !== 0) throw new Error(`tmux split-window failed: ${r.stderr || r.stdout}`);
  const newPaneId = String(r.stdout || "").trim();
  if (!newPaneId) throw new Error("tmux split-window returned empty pane id");
  return { paneId: newPaneId };
}

export async function tmuxPaneWindowId(paneId: string, client: TmuxClient = DEFAULT_TMUX): Promise<string | null> {
  const r = await tmuxCommand(client, ["display-message", "-p", "-t", paneId, "#{window_id}"], { timeout: 1000 });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
}

export async function tmuxKillPane(paneId: string, client: TmuxClient = DEFAULT_TMUX): Promise<void> {
  const r = await tmuxCommand(client, ["kill-pane", "-t", paneId], { timeout: 1500 });
  if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux kill-pane failed (status ${r.status})`));
}

interface TmuxSessionWithWindows {
  name: string;
  windows: string[];
}

/** tmux's words for a server that is not there. Any other failed connection
 *  (a refused permission, no resources) is reported alike but proves nothing. */
const NO_TMUX_SERVER = /no server running|error connecting to .*\(No such file or directory\)/;

/** Every pane tmux has now, by id and pid; [] when no tmux server runs, and
 *  null when tmux could not say (a failed listing proves no pane gone). */
export async function tmuxLivePanes(client: TmuxClient = DEFAULT_TMUX): Promise<Array<{ paneId: string; pid: number }> | null> {
  const r = await tmuxCommand(client, ["list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"], { timeout: 1500 });
  if (commandDidNotAnswer(r)) return null;
  // Only a server that is not there means no panes.
  if (r.status !== 0) return NO_TMUX_SERVER.test(r.stderr) ? [] : null;
  return r.stdout.split("\n").flatMap((line) => {
    const [paneId, pid] = line.trim().split(" ");
    return paneId?.startsWith("%") && Number(pid) > 0 ? [{ paneId, pid: Number(pid) }] : [];
  });
}

/** The pid of the pane holding `paneId` now; null when no pane does (tmux
 *  cannot find it, or no tmux server runs). Any other failure says nothing
 *  about the pane, and throws. */
export async function tmuxPanePid(paneId: string, client: TmuxClient = DEFAULT_TMUX): Promise<number | null> {
  const r = await tmuxCommand(client, ["display-message", "-p", "-t", paneId, "#{pane_pid}"], { timeout: 1500 });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux display-message");
  if (r.status !== 0) {
    if (/can't find pane/.test(r.stderr) || NO_TMUX_SERVER.test(r.stderr)) return null;
    throw new Error(commandFailureMessage(r, `tmux display-message failed (status ${r.status})`));
  }
  const pid = Number(r.stdout.trim());
  return pid > 0 ? pid : null;
}

export async function tmuxListSessionsWithWindows(client: TmuxClient = DEFAULT_TMUX): Promise<TmuxSessionWithWindows[]> {
  const r = await tmuxCommand(client, ["list-windows", "-a", "-F", `#{session_name}${FIELD_SEP}#{window_name}`], {
    timeout: 1500
  });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-windows");
  if (r.status !== 0) return [];
  const map = new Map<string, string[]>();
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [session, win] = trimmed.split(FIELD_SEP);
    if (!session || !win) continue;
    if (!map.has(session)) map.set(session, []);
    map.get(session)!.push(win);
  }
  return [...map.entries()].map(([name, windows]) => ({ name, windows }));
}
