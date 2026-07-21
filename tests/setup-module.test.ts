import { expect, test } from "bun:test";
import { probeTmux } from "../src/server/modules/setup/module.js";
import type { CommandRunner } from "../src/server/platform/process/command-runner.js";

test("probeTmux checks the tmux executable directly", () => {
  const runner: CommandRunner = {
    run(command, args) {
      expect(command).toBe("/opt/homebrew/bin/tmux");
      expect(args).toEqual(["-L", "mandate-test", "-V"]);
      return {
        status: 0,
        signal: null,
        stdout: "tmux 3.5a\n",
        stderr: ""
      };
    }
  };

  expect(probeTmux({
    socketArgs: ["-L", "mandate-test"],
    binary: "/opt/homebrew/bin/tmux",
    runner
  })).toEqual({ ok: true });
});

test("probeTmux reports missing tmux executable", () => {
  const runner: CommandRunner = {
    run(command, args) {
      expect(command).toBe("tmux");
      expect(args).toEqual(["-V"]);
      return {
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: new Error('Executable not found in $PATH: "tmux"')
      };
    }
  };

  expect(probeTmux({ socketArgs: [], runner })).toEqual({
    ok: false,
    error: 'Executable not found in $PATH: "tmux"'
  });
});
