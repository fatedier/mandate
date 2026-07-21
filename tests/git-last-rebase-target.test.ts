import { describe, expect, test } from "bun:test";
import { gitLastRebaseTarget } from "../src/server/platform/git/git.js";
import type { CommandResult, CommandRunner } from "../src/server/platform/process/command-runner.js";

/**
 * `base_ref` is written when Mandate creates a feature and never again, so a
 * rebase performed by an agent in a shell leaves it naming the old fork. The
 * old ref usually stays an ancestor, so `merge-base` still resolves — just far
 * behind. On a real store that showed 258 changed files where the work was 16.
 *
 * git recorded the answer at the time. This reads it rather than inferring a
 * base from topology, and answers null wherever it cannot be sure, because the
 * caller keeps its stored base then.
 */

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

/** The shape git writes, taken from a real worktree's reflog. */
const REAL_REFLOG = [
  "1dd4990b7 HEAD@{0}: rebase (finish): returning to refs/heads/research/nova-model-cost-map-entries",
  "1dd4990b7 HEAD@{1}: rebase (pick): nova: migrate model cost map to entries",
  "5f44c8dd0 HEAD@{2}: rebase (start): checkout origin/master",
  "8be09b29f HEAD@{5}: reset: moving to HEAD",
  "8be09b29f HEAD@{6}: checkout: moving from master to research/nova-model-cost-map-entries"
].join("\n");

describe("gitLastRebaseTarget", () => {
  test("reads the ref the rebase was given, not a commit", () => {
    // The point of using the reflog at all: `origin/master` is what was typed,
    // where topology could only offer the commit it happened to resolve to.
    const r = runner(REAL_REFLOG);
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
    // Four of six live features are in this state, and each must keep the base
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
    const r = runner(REAL_REFLOG);
    gitLastRebaseTarget("/some/worktree", { runner: r.runner });
    expect(r.calls[0]).toEqual([
      "-C", "/some/worktree", "reflog", "show", "--no-abbrev", "HEAD"
    ]);
  });

  test("a merge in the reflog is not a rebase", () => {
    // nova's own reflog carries `merge master: Fast-forward` before the rebase.
    // A merge moves the branch forward; it does not change what it forked from.
    const merged = [
      "aaa HEAD@{0}: merge master: Fast-forward",
      "bbb HEAD@{1}: commit: work"
    ].join("\n");
    const r = runner(merged);
    expect(gitLastRebaseTarget("/repo", { runner: r.runner })).toBeNull();
  });
});
