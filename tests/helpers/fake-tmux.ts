import type { CommandResult, CommandRunner } from "../../src/server/platform/process/command-runner.js";
import type { TmuxClient } from "../../src/server/platform/tmux/tmux.js";

/**
 * An in-memory tmux for tests whose subject is not tmux.
 *
 * Most tests that touch tmux are not about tmux: they assert that a project
 * row is written, that an API returns 409, that archiving cascades. They only
 * reach a tmux call because creating a project happens to open a session. Those
 * tests do not need a process — they need something that answers the way tmux
 * answers, so what they actually assert can run on a machine with no tmux at
 * all. Tests whose subject IS tmux live under e2e/ and drive the real thing.
 *
 * Fidelity here is set by observation, not by guesswork: the command surface
 * and the exact replies below were recorded off a real tmux 3.4 running the
 * suite. Two deliberate departures, both so the fake reads the same on every
 * machine:
 *
 *   - pane_current_command is always "sh". Real tmux reports whatever
 *     default-shell resolves to, which is "bash" on macOS and "dash" on
 *     Debian for the same /bin/sh.
 *   - pane_pid counts up from a fixed base instead of being a real pid.
 *
 * Nothing asserts on either today, and if something ever needs a real pid it
 * needs a real tmux, which means it belongs in e2e/.
 */

interface FakePane {
  id: string;
  command: string;
  path: string;
  pid: number;
}

interface FakeWindow {
  id: string;
  name: string;
  panes: FakePane[];
}

interface FakeSession {
  name: string;
  windows: FakeWindow[];
}

export interface FakeTmuxServer {
  client: TmuxClient;
  /** Every invocation in order, without the socket args. Lets a test assert on
   *  what was issued rather than only on what came back. */
  calls: string[][];
  cleanup: () => void;
}

/** The window a fresh session gets. Real tmux names it after default-shell,
 *  and the test config pins that to /bin/sh, so "sh" is what the suite has
 *  always seen. */
const DEFAULT_WINDOW_NAME = "sh";

const OK: CommandResult = { status: 0, signal: null, stdout: "", stderr: "" };

function fail(stderr: string): CommandResult {
  return { status: 1, signal: null, stdout: "", stderr };
}

function out(stdout: string): CommandResult {
  return { status: 0, signal: null, stdout, stderr: "" };
}

export function startFakeTmuxServer(): FakeTmuxServer {
  const sessions = new Map<string, FakeSession>();
  const calls: string[][] = [];
  let nextWindow = 0;
  let nextPane = 0;
  let nextPid = 10_000;

  const newPane = (path: string): FakePane => ({
    id: `%${nextPane++}`,
    command: "sh",
    path,
    pid: nextPid++
  });

  const newWindow = (name: string, path: string): FakeWindow => ({
    id: `@${nextWindow++}`,
    name,
    panes: [newPane(path)]
  });

  /**
   * tmux takes a session target as an exact name, or failing that as a unique
   * prefix, and refuses one that matches more than one session. Project code
   * leans on the prefix rule harder than it looks: a session is stored as
   * `md-p-2784c3e426` but looked up as `md-p`, so a fake that only matched
   * exactly would answer "no such session" to a question real tmux answers.
   */
  const findSession = (name: string): FakeSession | undefined => {
    const exact = sessions.get(name);
    if (exact) return exact;
    const prefixed = [...sessions.values()].filter((session) => session.name.startsWith(name));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  };

  /** Resolves the target forms the codebase actually builds: a session name, a
   *  `session:window` pair, a `%pane` id, or an `@window` id. */
  const resolve = (target: string): {
    session?: FakeSession;
    window?: FakeWindow;
    pane?: FakePane;
  } => {
    if (target.startsWith("%")) {
      for (const session of sessions.values()) {
        for (const window of session.windows) {
          const pane = window.panes.find((candidate) => candidate.id === target);
          if (pane) return { session, window, pane };
        }
      }
      return {};
    }
    if (target.startsWith("@")) {
      for (const session of sessions.values()) {
        const window = session.windows.find((candidate) => candidate.id === target);
        if (window) return { session, window, pane: window.panes[0] };
      }
      return {};
    }
    const [sessionName, windowName] = target.split(":");
    const session = findSession(sessionName ?? "");
    if (!session) return {};
    if (windowName === undefined) {
      return { session, window: session.windows[0], pane: session.windows[0]?.panes[0] };
    }
    const window = session.windows.find((candidate) => candidate.name === windowName);
    return window ? { session, window, pane: window.panes[0] } : { session };
  };

  /** Substitutes `#{...}` the way tmux does, so a caller can change its format
   *  string without this file having to know. An unknown field expands empty,
   *  which is also what tmux does for one it cannot fill — pane_start_time
   *  comes back empty from the real thing too. */
  const expand = (
    format: string,
    scope: { session?: FakeSession; window?: FakeWindow; pane?: FakePane }
  ): string => {
    const values: Record<string, string> = {
      session_name: scope.session?.name ?? "",
      window_id: scope.window?.id ?? "",
      window_name: scope.window?.name ?? "",
      window_index: scope.session && scope.window
        ? String(scope.session.windows.indexOf(scope.window))
        : "",
      window_active: "1",
      pane_id: scope.pane?.id ?? "",
      pane_index: scope.window && scope.pane
        ? String(scope.window.panes.indexOf(scope.pane))
        : "",
      pane_active: scope.window && scope.pane
        ? (scope.window.panes.indexOf(scope.pane) === 0 ? "1" : "0")
        : "",
      pane_title: scope.window?.name ?? "",
      pane_pid: scope.pane ? String(scope.pane.pid) : "",
      pane_current_command: scope.pane?.command ?? "",
      pane_current_path: scope.pane?.path ?? "",
      current_command: scope.pane?.command ?? "",
      current_path: scope.pane?.path ?? "",
      // Real tmux 3.4 returns this empty for a pane it just created.
      pane_start_time: ""
    };
    return format.replace(/#\{([a-z_]+)\}/g, (_match, field: string) => values[field] ?? "");
  };

  const flagValue = (args: string[], flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };

  const run = (args: string[]): CommandResult => {
    const [subcommand, ...rest] = args;
    const target = flagValue(rest, "-t");
    const format = flagValue(rest, "-F");

    switch (subcommand) {
      case "has-session": {
        const { session } = resolve(target ?? "");
        return session ? OK : fail(`can't find session: ${target}`);
      }

      case "new-session": {
        const name = flagValue(rest, "-s") ?? "";
        // Real tmux refuses rather than silently adopting the existing one,
        // and project creation relies on that to detect a name collision.
        if (sessions.has(name)) return fail(`duplicate session: ${name}`);
        const cwd = flagValue(rest, "-c") ?? "/";
        sessions.set(name, { name, windows: [newWindow(DEFAULT_WINDOW_NAME, cwd)] });
        return OK;
      }

      case "kill-session": {
        const { session } = resolve(target ?? "");
        if (!session) return fail(`can't find session: ${target}`);
        sessions.delete(session.name);
        return OK;
      }

      case "new-window": {
        const { session } = resolve(target ?? "");
        if (!session) return fail(`can't find session: ${target}`);
        const name = flagValue(rest, "-n") ?? DEFAULT_WINDOW_NAME;
        session.windows.push(newWindow(name, flagValue(rest, "-c") ?? "/"));
        return OK;
      }

      case "kill-window": {
        const { session, window } = resolve(target ?? "");
        if (!session || !window) return fail(`can't find window: ${target}`);
        session.windows.splice(session.windows.indexOf(window), 1);
        // tmux tears the session down with its last window.
        if (session.windows.length === 0) sessions.delete(session.name);
        return OK;
      }

      case "kill-pane": {
        const { session, window, pane } = resolve(target ?? "");
        if (!session || !window || !pane) return fail(`can't find pane: ${target}`);
        window.panes.splice(window.panes.indexOf(pane), 1);
        if (window.panes.length === 0) {
          session.windows.splice(session.windows.indexOf(window), 1);
          if (session.windows.length === 0) sessions.delete(session.name);
        }
        return OK;
      }

      case "split-window": {
        const { window } = resolve(target ?? "");
        if (!window) return fail(`can't find pane: ${target}`);
        const pane = newPane(flagValue(rest, "-c") ?? window.panes[0]?.path ?? "/");
        window.panes.push(pane);
        return out(format ? `${expand(format, { window, pane })}\n` : `${pane.id}\n`);
      }

      case "list-sessions": {
        // tmux exits non-zero when there is no server to list, and
        // tmuxListSessions reads that status to mean "none" rather than
        // "empty output".
        if (sessions.size === 0) return fail("no server running");
        const lines = [...sessions.values()].map((session) =>
          expand(format ?? "#{session_name}", { session, window: session.windows[0] })
        );
        return out(`${lines.join("\n")}\n`);
      }

      case "list-windows": {
        if (rest.includes("-a")) {
          if (sessions.size === 0) return fail("no server running");
          const lines: string[] = [];
          for (const session of sessions.values()) {
            for (const window of session.windows) {
              lines.push(expand(format ?? "#{window_name}", { session, window, pane: window.panes[0] }));
            }
          }
          return out(`${lines.join("\n")}\n`);
        }
        const { session } = resolve(target ?? "");
        if (!session) return fail(`can't find session: ${target}`);
        const lines = session.windows.map((window) =>
          expand(format ?? "#{window_name}", { session, window, pane: window.panes[0] })
        );
        return out(`${lines.join("\n")}\n`);
      }

      case "list-panes": {
        if (rest.includes("-a")) {
          const lines: string[] = [];
          for (const session of sessions.values()) {
            for (const window of session.windows) {
              for (const pane of window.panes) {
                lines.push(expand(format ?? "#{pane_id}", { session, window, pane }));
              }
            }
          }
          return out(lines.length ? `${lines.join("\n")}\n` : "");
        }
        const { session, window } = resolve(target ?? "");
        if (!window) return fail(`can't find window: ${target}`);
        const lines = window.panes.map((pane) =>
          expand(format ?? "#{pane_id}", { session, window, pane })
        );
        return out(`${lines.join("\n")}\n`);
      }

      case "display-message": {
        const scope = resolve(target ?? "");
        if (!scope.session) return fail(`can't find target: ${target}`);
        // The format is the trailing argument rather than a -F value here.
        const template = rest[rest.length - 1] ?? "";
        return out(`${expand(template, scope)}\n`);
      }

      // pipe-pane is a no-op for a fake: there is no pane producing bytes, and
      // a test that needs real streaming needs a real tmux.
      case "pipe-pane":
        return OK;

      default:
        // Louder than a non-zero status on purpose. A missing command here is
        // a gap in the harness, not an outcome tmux produced, and returning
        // "failed" would let a caller that ignores status carry on against a
        // model that never changed.
        throw new Error(
          `fake tmux does not implement \`${subcommand}\`. Add it here, or move the ` +
          `test to e2e/ if what it needs is a real tmux.`
        );
    }
  };

  const runner: CommandRunner = {
    run(_command, args) {
      calls.push(args);
      return run(args);
    }
  };

  return {
    client: { socketArgs: [], runner },
    calls,
    cleanup: () => {
      sessions.clear();
      calls.length = 0;
    }
  };
}
