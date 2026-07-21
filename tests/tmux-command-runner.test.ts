import { expect, test } from "bun:test";
import {
  tmuxCommand,
  tmuxKillPane,
  tmuxListSessions,
  type TmuxClient
} from "../src/server/platform/tmux/tmux.js";
import type { CommandRunner } from "../src/server/platform/process/command-runner.js";

function fakeRunner(
  handler: CommandRunner["run"]
): { runner: CommandRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    runner: {
      run(command, args, options) {
        calls.push({ command, args });
        return handler(command, args, options);
      }
    }
  };
}

test("tmuxCommand uses injectable runner, binary, and socket args", () => {
  const { runner, calls } = fakeRunner(() => ({
    status: 0,
    signal: null,
    stdout: "ok",
    stderr: ""
  }));
  const client: TmuxClient = {
    binary: "/custom/tmux",
    socketArgs: ["-L", "isolated"],
    runner
  };

  const result = tmuxCommand(client, ["list-sessions"], { timeout: 1234 });

  expect(result.stdout).toBe("ok");
  expect(calls).toEqual([
    {
      command: "/custom/tmux",
      args: ["-L", "isolated", "list-sessions"]
    }
  ]);
});

test("tmux helpers use injectable runner instead of spawning tmux directly", () => {
  const { runner, calls } = fakeRunner((_command, args) => ({
    status: 0,
    signal: null,
    stdout: args.includes("list-sessions") ? "alpha\nbeta\n" : "",
    stderr: ""
  }));

  const sessions = tmuxListSessions({ socketArgs: ["-S", "/tmp/test.sock"], runner });

  expect(sessions).toEqual(["alpha", "beta"]);
  expect(calls[0]?.args).toEqual(["-S", "/tmp/test.sock", "list-sessions", "-F", "#{session_name}"]);
});

test("tmux helpers surface runner failures", () => {
  const { runner } = fakeRunner(() => ({
    status: 1,
    signal: null,
    stdout: "",
    stderr: "pane missing"
  }));

  expect(() => tmuxKillPane("%404", { socketArgs: [], runner })).toThrow("pane missing");
});

