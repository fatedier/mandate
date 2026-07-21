import { FIELD_SEP } from "../text/text.js";
import {
  commandFailureMessage,
  nodeCommandRunner,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner
} from "../process/command-runner.js";

export interface TmuxClient {
  /** Extra args inserted before any subcommand. e.g. ["-L", "test-123"] for an isolated test server. */
  socketArgs: string[];
  /** Command runner abstraction for tests and alternate tmux execution backends. */
  runner?: CommandRunner;
  /** Binary name/path. Defaults to `tmux`. */
  binary?: string;
}

export const DEFAULT_TMUX: TmuxClient = { socketArgs: [] };

export function tmuxCommand(
  client: TmuxClient,
  args: string[],
  options?: CommandRunOptions
): CommandResult {
  return (client.runner ?? nodeCommandRunner).run(
    client.binary ?? "tmux",
    [...client.socketArgs, ...args],
    options
  );
}

export function tmuxHasSession(name: string, client: TmuxClient = DEFAULT_TMUX): boolean {
  const r = tmuxCommand(client, ["has-session", "-t", name], { timeout: 1500 });
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
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function tmuxHasWindow(session: string, windowName: string, client: TmuxClient = DEFAULT_TMUX): boolean {
  const windows = tmuxListWindows(session, client);
  return windows.includes(windowName);
}

export function tmuxListWindows(session: string, client: TmuxClient = DEFAULT_TMUX): string[] {
  const r = tmuxCommand(client, ["list-windows", "-t", session, "-F", "#{window_name}"], { timeout: 1500 });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function tmuxNewWindow(session: string, windowName: string, cwd: string, client: TmuxClient = DEFAULT_TMUX): void {
  const r = tmuxCommand(client, ["new-window", "-d", "-t", session, "-n", windowName, "-c", cwd], { timeout: 2500 });
  if (r.status !== 0) throw new Error(commandFailureMessage(r, `tmux new-window failed (status ${r.status})`));
}

export function tmuxKillWindow(session: string, windowName: string, client: TmuxClient = DEFAULT_TMUX): void {
  const target = `${session}:${windowName}`;
  const r = tmuxCommand(client, ["kill-window", "-t", target], { timeout: 1500 });
  if (r.status !== 0) throw new Error(`tmux kill-window failed: ${r.stderr || r.stdout}`);
}

export interface TmuxSplitResult {
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

export interface TmuxSessionWithWindows {
  name: string;
  windows: string[];
}

export function tmuxListSessionsWithWindows(client: TmuxClient = DEFAULT_TMUX): TmuxSessionWithWindows[] {
  const r = tmuxCommand(client, ["list-windows", "-a", "-F", `#{session_name}${FIELD_SEP}#{window_name}`], {
    timeout: 1500
  });
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
