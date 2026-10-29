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

export function tmuxCommand(
  client: TmuxClient,
  args: string[],
  options?: CommandRunOptions
): CommandResult {
  return (client.runner ?? nodeCommandRunner).run(
    "tmux",
    [...client.socketArgs, ...args],
    options
  );
}

export function tmuxHasSession(name: string, client: TmuxClient = DEFAULT_TMUX): boolean {
  const r = tmuxCommand(client, ["has-session", "-t", name], { timeout: 1500 });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux has-session");
  return r.status === 0;
}

export function tmuxNewSession(name: string, cwd: string, client: TmuxClient = DEFAULT_TMUX): void {
  const r = tmuxCommand(client, ["new-session", "-d", "-s", name, "-c", cwd], { timeout: 2500 });
  if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux new-session failed (status ${r.status})`));
}

export function tmuxKillSession(name: string, client: TmuxClient = DEFAULT_TMUX): void {
  tmuxCommand(client, ["kill-session", "-t", name], { timeout: 1500 });
}

export function tmuxListSessions(client: TmuxClient = DEFAULT_TMUX): string[] {
  const r = tmuxCommand(client, ["list-sessions", "-F", "#{session_name}"], { timeout: 1500 });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-sessions");
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function tmuxHasWindow(session: string, windowName: string, client: TmuxClient = DEFAULT_TMUX): boolean {
  const windows = tmuxListWindows(session, client);
  return windows.includes(windowName);
}

export function tmuxListWindows(session: string, client: TmuxClient = DEFAULT_TMUX): string[] {
  const r = tmuxCommand(client, ["list-windows", "-t", session, "-F", "#{window_name}"], { timeout: 1500 });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-windows");
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Opens a window and returns its id (`@N`): the one target that names it
 *  and nothing else. */
export function tmuxNewWindow(session: string, windowName: string, cwd: string, client: TmuxClient = DEFAULT_TMUX): string {
  const r = tmuxCommand(
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
export function tmuxKillWindow(session: string, windowName: string, client: TmuxClient = DEFAULT_TMUX): void {
  const r = tmuxCommand(client, ["list-windows", "-t", session, "-F", `#{window_id}${FIELD_SEP}#{window_name}`], {
    timeout: 1500
  });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("tmux list-windows");
  if (r.status !== 0) throw new Error(`tmux kill-window failed: ${r.stderr || r.stdout}`);
  const ids = r.stdout.split("\n").flatMap((line) => {
    const [id, name] = line.trim().split(FIELD_SEP);
    return id && name === windowName ? [id] : [];
  });
  if (ids.length === 0) throw new Error(`tmux kill-window failed: can't find window: ${session}:${windowName}`);
  for (const id of ids) tmuxKillWindowById(id, client);
}

export function tmuxKillWindowById(windowId: string, client: TmuxClient = DEFAULT_TMUX): void {
  const r = tmuxCommand(client, ["kill-window", "-t", windowId], { timeout: 1500 });
  if (r.status !== 0) throw new Error(`tmux kill-window failed: ${r.stderr || r.stdout}`);
}

interface TmuxSplitResult {
  paneId: string;
}

export function tmuxSplitPane(
  paneId: string,
  direction: "right" | "down",
  client: TmuxClient = DEFAULT_TMUX,
  options: { cwd?: string | null } = {}
): TmuxSplitResult {
  const flag = direction === "right" ? "-h" : "-v";
  const args = ["split-window", flag, "-t", paneId];
  if (options.cwd) args.push("-c", options.cwd);
  args.push("-P", "-F", "#{pane_id}");
  const r = tmuxCommand(client, args, { timeout: 2500 });
  if (r.status !== 0) throw new Error(`tmux split-window failed: ${r.stderr || r.stdout}`);
  const newPaneId = String(r.stdout || "").trim();
  if (!newPaneId) throw new Error("tmux split-window returned empty pane id");
  return { paneId: newPaneId };
}

export function tmuxPaneWindowId(paneId: string, client: TmuxClient = DEFAULT_TMUX): string | null {
  const r = tmuxCommand(client, ["display-message", "-p", "-t", paneId, "#{window_id}"], { timeout: 1000 });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
}

export function tmuxKillPane(paneId: string, client: TmuxClient = DEFAULT_TMUX): void {
  const r = tmuxCommand(client, ["kill-pane", "-t", paneId], { timeout: 1500 });
  if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux kill-pane failed (status ${r.status})`));
}

interface TmuxSessionWithWindows {
  name: string;
  windows: string[];
}

export function tmuxListSessionsWithWindows(client: TmuxClient = DEFAULT_TMUX): TmuxSessionWithWindows[] {
  const r = tmuxCommand(client, ["list-windows", "-a", "-F", `#{session_name}${FIELD_SEP}#{window_name}`], {
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
