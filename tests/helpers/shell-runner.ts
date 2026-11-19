import { createShellCommandRunner, type KillTimings, type ShellCommandRunner, type ShellProcess, type ShellProcessExit } from "../../src/server/platform/process/shell-command-runner.js";

/** A killed command's waits in tests: SIGKILL 200 ms after the SIGTERM, and
 *  the call settled 100 ms after that (the server waits 2 s and 1 s). */
export const QUICK_KILL: KillTimings = { escalationMs: 200, forceSettleMs: 100 };

/** A runner for tests: /bin/bash, with `home` as its HOME and its snapshot's
 *  directory, so it never reads the user's shell or start-up files, and a
 *  killed command's quick waits. `over` changes any of that. */
export function testShellRunner(home: string, over: Parameters<typeof createShellCommandRunner>[0] = {}): ShellCommandRunner {
  return createShellCommandRunner({
    shell: { path: "/bin/bash", type: "bash" },
    snapshotDir: home,
    captureEnv: { HOME: home, PATH: "/usr/bin:/bin" },
    killTimings: QUICK_KILL,
    ...over
  });
}

/** The command `runningCommand` names: it runs until it is killed. */
export const RUNS_UNTIL_KILLED = "run-until-killed";

/** `runner`, but RUNS_UNTIL_KILLED starts no program: a process that prints
 *  nothing and ends, as a killed one does, when it is killed. For a test
 *  that needs a command still running, without an external binary. */
export function withRunningCommand(runner: ShellCommandRunner): ShellCommandRunner {
  return {
    run: (command, options) => runner.run(command, options),
    spawn: async (command, options) => {
      if (command !== RUNS_UNTIL_KILLED) return runner.spawn(command, options);
      let end!: (exit: ShellProcessExit) => void;
      const exited = new Promise<ShellProcessExit>((resolve) => { end = resolve; });
      const process: ShellProcess = { pid: null, onOutput: () => {}, exited, kill: () => end({ code: null, signal: "SIGTERM" }) };
      return process;
    }
  };
}
