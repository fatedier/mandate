import { createShellCommandRunner, type KillTimings, type ShellCommandRunner } from "../../src/server/platform/process/shell-command-runner.js";

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
