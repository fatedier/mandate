import { describe, expect, test } from "bun:test";
import {
  gitBranchExists,
  gitCommand,
  gitDetectRepository,
  gitLastRebaseTarget,
  gitResolveDefaultBaseRef,
  gitWorktreeAdd,
  gitWorktreeRemove,
  type GitClient
} from "../src/server/platform/git/git.js";
import { gitDiffNames } from "../src/server/platform/git/git-diff.js";
import type { CommandResult, CommandRunner } from "../src/server/platform/process/command-runner.js";

describe("git helpers through an injected runner", () => {
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

  test("gitCommand uses injectable runner", () => {
    const { runner, calls } = fakeRunner(() => ({
      status: 0,
      signal: null,
      stdout: "ok",
      stderr: ""
    }));
    const client: GitClient = { runner };

    const result = gitCommand(client, ["status"], { timeout: 1234 });

    expect(result.stdout).toBe("ok");
    expect(calls).toStrictEqual([{ command: "git", args: ["status"] }]);
  });

  test("git helpers use injectable runner instead of spawning git directly", () => {
    const { runner, calls } = fakeRunner(() => ({
      status: 0,
      signal: null,
      stdout: "",
      stderr: ""
    }));
    const client: GitClient = { runner };

    expect(gitBranchExists("/repo", "main", client)).toBe(true);
    expect(calls[0]?.args).toEqual(["-C", "/repo", "show-ref", "--verify", "refs/heads/main"]);
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

  test("gitWorktreeAdd: allows large checkout time", () => {
    const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
    const client: GitClient = {
      runner: {
        run(_command, args, options) {
          calls.push({ args, timeout: options?.timeout });
          return { status: 0, signal: null, stdout: "", stderr: "" };
        }
      }
    };

    gitWorktreeAdd("/repo", "/repo-worktree", "feature-y", { newBranch: true }, client);

    expect(calls).toStrictEqual([{
      args: ["-C", "/repo", "worktree", "add", "-b", "feature-y", "/repo-worktree"],
      timeout: 60_000
    }]);
  });

  test("gitWorktreeRemove: allows large remove time", () => {
    const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
    const client: GitClient = {
      runner: {
        run(_command, args, options) {
          calls.push({ args, timeout: options?.timeout });
          return { status: 0, signal: null, stdout: "", stderr: "" };
        }
      }
    };

    gitWorktreeRemove("/repo-worktree", "/repo", {}, client);
    gitWorktreeRemove("/repo-worktree", "/repo", { force: true }, client);

    expect(calls).toStrictEqual([
      {
        args: ["-C", "/repo", "worktree", "remove", "/repo-worktree"],
        timeout: 60_000
      },
      {
        args: ["-C", "/repo", "worktree", "remove", "--force", "/repo-worktree"],
        timeout: 60_000
      }
    ]);
  });
});

describe("gitDiffNames", () => {
  test("spawns exactly two git commands", () => {
    let spawns = 0;
    const fake: GitClient = {
      runner: {
        run: (_bin: string, args: string[]) => {
          spawns += 1;
          if (args.includes("--name-status")) {
            return { status: 0, signal: null, stdout: "M\0a.txt\0", stderr: "" };
          }
          return { status: 0, signal: null, stdout: "u.txt\0", stderr: "" };
        }
      }
    };
    const names = gitDiffNames("/repo", "deadbeef", fake)!;
    expect(spawns).toBe(2);
    expect(names.map((n) => n.path)).toEqual(["a.txt", "u.txt"]);
  });
});

describe("gitResolveDefaultBaseRef", () => {
  /** Answers git by the argument list after `-C <dir>`; unknown commands fail. */
  function fakeGit(answers: Record<string, string>): GitClient {
    return {
      runner: {
        run: (_bin: string, args: string[]) => {
          const out = answers[args.slice(2).join(" ")];
          return { status: out === undefined ? 1 : 0, signal: null, stdout: out ?? "", stderr: "" };
        }
      }
    };
  }

  const REMOTE_DEFAULT = "symbolic-ref --quiet --short refs/remotes/origin/HEAD";
  const CURRENT = "branch --show-current";
  const COMMIT = "rev-parse --verify HEAD";
  const EXISTS = (ref: string) => `rev-parse --verify ${ref}^{commit}`;

  test("a new worker's default base is the remote's default branch, whatever branch the project's checkout is on", () => {
    expect(gitResolveDefaultBaseRef("/repo", fakeGit({ [REMOTE_DEFAULT]: "origin/master\n", [EXISTS("origin/master")]: "abc123\n", [CURRENT]: "feature-1\n", [COMMIT]: "abc123\n" }))).toBe("origin/master");
  });

  test("a remote default that names a branch no longer there is passed over", () => {
    // A default branch renamed upstream, the old one pruned: origin/HEAD still names it.
    expect(gitResolveDefaultBaseRef("/repo", fakeGit({ [REMOTE_DEFAULT]: "origin/master\n", [CURRENT]: "feature-1\n", [COMMIT]: "abc123\n" }))).toBe("feature-1");
  });

  test("with no remote default it is the checkout's branch, and on a detached checkout its commit", () => {
    expect(gitResolveDefaultBaseRef("/repo", fakeGit({ [CURRENT]: "main\n", [COMMIT]: "abc123\n" }))).toBe("main");
    expect(gitResolveDefaultBaseRef("/repo", fakeGit({ [CURRENT]: "\n", [COMMIT]: "abc123\n" }))).toBe("abc123");
    expect(gitResolveDefaultBaseRef("/repo", fakeGit({}))).toBeNull();
  });
});

/**
 * `base_ref` is written when Mandate creates a feature and never again, so a
 * rebase performed by an agent in a shell leaves it naming the old fork. The
 * old ref usually stays an ancestor, so `merge-base` still resolves — just far
 * behind, and the comparison then lists far more files than the work touched.
 *
 * git recorded the answer at the time. This reads it rather than inferring a
 * base from topology, and answers null wherever it cannot be sure, because the
 * caller keeps its stored base then.
 */
describe("gitLastRebaseTarget", () => {
  function runner(stdout: string, status = 0): { runner: CommandRunner; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      runner: {
        run(_command: string, args: string[]): CommandResult {
          calls.push(args);
          return { status, signal: null, stdout, stderr: "" };
        }
      }
    };
  }

  /** The shape git writes for a rebase. */
  const REFLOG = [
    "aaa111122 HEAD@{0}: rebase (finish): returning to refs/heads/feature/table-entries",
    "aaa111122 HEAD@{1}: rebase (pick): table: migrate the rows to entries",
    "bbb222233 HEAD@{2}: rebase (start): checkout origin/master",
    "ccc333344 HEAD@{5}: reset: moving to HEAD",
    "ccc333344 HEAD@{6}: checkout: moving from master to feature/table-entries"
  ].join("\n");

  test("reads the ref the rebase was given, not a commit", () => {
    // The point of using the reflog at all: `origin/master` is what was typed,
    // where topology could only offer the commit it happened to resolve to.
    const r = runner(REFLOG);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBe("origin/master");
  });

  test("takes the most recent rebase when there have been several", () => {
    // Reflog is newest-first, so the first match is the current answer. Reading
    // the last would report the base two rebases ago.
    const twice = [
      "aaa HEAD@{0}: rebase (finish): returning to refs/heads/feat",
      "aaa HEAD@{1}: rebase (start): checkout origin/release",
      "bbb HEAD@{2}: rebase (finish): returning to refs/heads/feat",
      "bbb HEAD@{3}: rebase (start): checkout origin/master"
    ].join("\n");
    const r = runner(twice);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBe("origin/release");
  });

  test("recognises an interactive rebase", () => {
    const interactive = "ccc HEAD@{0}: rebase -i (start): checkout main";
    const r = runner(interactive);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBe("main");
  });

  test("answers null when the branch was never rebased", () => {
    // Many features are in this state, and each must keep the base
    // it was created from.
    const noRebase = [
      "aaa HEAD@{0}: commit: work",
      "bbb HEAD@{1}: checkout: moving from dev to feat"
    ].join("\n");
    const r = runner(noRebase);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBeNull();
  });

  test("answers null on a message it does not recognise", () => {
    // Reflog text is git's, not ours. A format it does not match must leave the
    // stored base alone rather than produce a guess.
    const r = runner("ddd HEAD@{0}: rebase (start): onto 5f44c8d");
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBeNull();
  });

  test("answers null when the reflog cannot be read", () => {
    const r = runner("", 128);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBeNull();
  });

  test("does not read the output of a command that failed", () => {
    // Contrived on purpose: git writes nothing to stdout when it fails here, so
    // an empty-stdout case cannot tell whether the status is checked at all.
    // The guard says the contract is "a failed command is not a source", rather
    // than resting on git's choice of where to write on failure.
    const r = runner("eee HEAD@{0}: rebase (start): checkout origin/master", 128);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBeNull();
  });

  test("asks for full hashes and scopes the command to the repo", () => {
    const r = runner(REFLOG);
    gitLastRebaseTarget("/some/worktree", { runner: r.runner });
    expect(r.calls[0]).toEqual([
      "-C", "/some/worktree", "reflog", "show", "--no-abbrev", "HEAD"
    ]);
  });

  test("a merge in the reflog is not a rebase", () => {
    // A reflog can carry `merge master: Fast-forward` before the rebase.
    // A merge moves the branch forward; it does not change what it forked from.
    const merged = [
      "aaa HEAD@{0}: merge master: Fast-forward",
      "bbb HEAD@{1}: commit: work"
    ].join("\n");
    const r = runner(merged);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBeNull();
  });
});
