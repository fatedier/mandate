---
name: dev-workflow
description: Coordinate local Mandate development and Git commits. Use for implementation, refactoring, commit, amend, or combining local commits. Delegate verification to preflight and stop at the outcome requested by the user.
---

# Local development workflow

Use [AGENTS.md](../../../AGENTS.md) for project rules and
[preflight](../preflight/SKILL.md) for verification. This workflow completes work
locally; GitHub, PRs, and CI are not required stages.

## Choose the requested outcome

| Request | Outcome |
| --- | --- |
| Discuss, plan, inspect, or review only | Read-only findings or a proposal. |
| Implement or refactor | Completed changes and the applicable verification. |
| Commit | Commit the requested changes and report the result. |
| Amend or combine with the previous commit | Update the intended commit and verify its contents and message. |
| Combine several local commits | Confirm the intended range from the request and history, then consolidate only that range. |

Continue through steps already authorized in the conversation. An implementation
request does not automatically include a commit; a commit request does not
include a push. Ask only when scope or a consequential choice remains unresolved.

## Inspect and implement

1. Check the repository root, current branch, `git status --short`, staged and
   unstaged diffs, untracked files, and recent commits. Identify task-owned work.
2. Preserve unrelated edits and staging; do not stash, reset, or discard them
   as routine setup. Investigate existing changes before editing overlapping
   files.
3. For implementation, read the affected code, callers, and tests; make the
   requested change and update affected documentation. Respect a discussion-only
   or read-only scope until the user asks for implementation.
4. Invoke preflight according to AGENTS.md. For small iterative fixes, run focused
   checks. Carry forward valid verification rather than rerunning unchanged work
   solely because a commit was requested.
5. Review the complete task diff before reporting or committing. Check new files,
   fixture data, screenshots, and logs for private information.

## Commit or amend when requested

1. Identify the exact files or hunks belonging to the request. Inspect existing
   staged changes; do not include unrelated work in the commit.
2. For an amend, inspect HEAD and confirm it is the intended commit. For several
   commits, inspect the requested range and preserve the changes and attribution
   that should remain. Do not infer permission to rewrite other commits or refs.
3. Stage task-owned changes explicitly, using hunks when a file contains unrelated
   edits. Inspect `git diff --cached` and run `git diff --cached --check`.
4. Write a concise English commit message describing the final change. Update the
   message on amend if the scope changed. Commit only the requested content.
5. Read back the commit with `git show --stat` and inspect its diff. Check
   `git status --short` to confirm remaining work and staging are as intended.

If unrelated staged content cannot be kept out of the requested commit while
preserving it, resolve that concrete staging conflict before committing. A clean
working tree alone does not establish that the committed changes were verified.

## Finish locally

Report what changed, validation outcomes and gaps, and the resulting commit SHA
when a commit was requested. Mention remaining task changes or unrelated work
when relevant. End at the requested local outcome; remote publication, release,
and deployment are separate requests.
