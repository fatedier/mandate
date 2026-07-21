import { expect, test } from "bun:test";
import {
  gitBranchExists,
  gitCommand,
  gitDetectRepository,
  gitListBranches,
  gitWorktreeAdd,
  type GitClient
} from "../src/server/platform/git/git.js";
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

test("gitCommand uses injectable runner and binary", () => {
  const { runner, calls } = fakeRunner(() => ({
    status: 0,
    signal: null,
    stdout: "ok",
    stderr: ""
  }));
  const client: GitClient = { binary: "/custom/git", runner };

  const result = gitCommand(client, ["status"], { timeout: 1234 });

  expect(result.stdout).toBe("ok");
  expect(calls).toEqual([{ command: "/custom/git", args: ["status"] }]);
});

test("git helpers use injectable runner instead of spawning git directly", () => {
  const { runner, calls } = fakeRunner((_command, args) => ({
    status: 0,
    signal: null,
    stdout: args.includes("branch") ? "main\norigin/main\norigin/HEAD -> origin/main\nfeature\n" : "",
    stderr: ""
  }));
  const client: GitClient = { runner };

  expect(gitListBranches("/repo", client)).toEqual(["feature", "main"]);
  expect(gitBranchExists("/repo", "main", client)).toBe(true);

  expect(calls[0]?.args).toEqual(["-C", "/repo", "branch", "-a", "--format=%(refname:short)"]);
  expect(calls[1]?.args).toEqual(["-C", "/repo", "show-ref", "--verify", "refs/heads/main"]);
});

test("gitDetectRepository uses injectable runner for probe and remote lookup", () => {
  const { runner, calls } = fakeRunner((_command, args) => {
    if (args.includes("rev-parse")) {
      return { status: 0, signal: null, stdout: ".git\n", stderr: "" };
    }
    return { status: 0, signal: null, stdout: "git@github.com:example/repo.git\n", stderr: "" };
  });

  expect(gitDetectRepository("/repo", { runner })).toEqual({
    isGit: true,
    gitRemote: "git@github.com:example/repo.git"
  });
  expect(calls.map((call) => call.args.slice(2))).toEqual([
    ["rev-parse", "--git-dir"],
    ["config", "--get", "remote.origin.url"]
  ]);
});

test("git helpers surface runner failures", () => {
  const { runner } = fakeRunner(() => ({
    status: 1,
    signal: null,
    stdout: "",
    stderr: "bad branch"
  }));

  expect(() =>
    gitWorktreeAdd("/repo", "/repo-wt", "feature", { newBranch: true }, { runner })
  ).toThrow("bad branch");
});
