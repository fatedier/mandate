---
name: preflight
description: Verify Mandate changes before reporting completion. Use after feature implementation or refactoring, or when asked to validate changes. Select checks for documentation, TypeScript, E2E, packaging, and desktop code.
---

# Preflight

Follow the trigger rules in [AGENTS.md](../../../AGENTS.md). Use
[Testing](../../../docs/agents/testing.md) for commands and environment details.
This skill verifies local changes; committing belongs to
[dev-workflow](../dev-workflow/SKILL.md).

## Select the checks

Inspect the complete task diff, including new files and any commits in scope.
Identify the affected behavior and select all applicable rows below. Begin with
the smallest meaningful check. A full preflight completes the applicable checks,
not every platform's suite regardless of the change.

| Change | Required checks |
| --- | --- |
| Documentation or agent instructions only | Validate referenced commands, local links, and skill metadata; run `git diff --check`. Check new files too. |
| Ignore rules or skill symlinks | Verify intended files are visible to Git, private paths remain ignored, and links resolve within the repository. |
| TypeScript source or tests | Run `bun run lint`, relevant type checks, and focused tests. Client/shared: `typecheck`; server/shared: `typecheck:server`; test changes: `typecheck:tests`. |
| Shared behavior, cross-module changes, refactors, or unclear impact | Also run all three type checks and `bun run test`. |
| UI or browser interactions | Run relevant Docker E2E tests and inspect the affected visible states. Check responsive layouts and themes where affected. |
| HTTP, SSE, WebSocket, tmux, process lifecycle, persistence, or agent/tool integration | Run relevant Docker E2E tests through the real compiled application. |
| Client assets, embedded product skills, binary build, or Docker packaging | Verify a fresh binary/image build and relevant E2E behavior. Docker E2E already builds the binary. |
| Tauri Rust code, desktop configuration, or sidecar integration | Run the relevant Rust checks, desktop build, and desktop-specific validation described in the testing guide. |

For a change affecting the shared E2E harness, application startup, or behavior
across many flows, run the full Docker E2E suite. For a bounded change, name the
selected cases and why they cover it. For other executable configuration or
scripts, inspect their consumers and validate the affected workflow.

## Run and review

1. Check the environment prerequisites and preserve existing user processes and
   data. Use the repository test harness and temporary state.
2. Run the selected static checks and focused tests, then the required broader
   suites and builds. Do not overlap heavy builds or suites that share artifacts.
3. Review the final diff for correctness, regressions, architecture boundaries,
   and accidental private data. Include untracked files and inspect any generated
   changes. Format only files belonging to the task.
4. Run `git diff --check`. For new files, also inspect whitespace because ordinary
   Git diff does not include untracked content.

## Failures and changes after verification

- Investigate failures and fix their cause within the task's scope. Do not mask
  them with weaker assertions, broad mocks, arbitrary sleeps, or retries.
- After a fix, rerun affected checks and finish the remaining selected checks.
  Reuse prior results only while their inputs and coverage still apply.
- Missing Docker, a required platform, or another prerequisite is a verification
  gap. Complete independent checks and report the exact blocker; do not claim
  that the affected checks passed.
- Stubbed providers establish local behavior, not live provider compatibility.
  Keep external calls within the task's authorization and report live-test gaps.

## Report

State the checks run, their outcomes, and any skipped checks with reasons. Tie
results to the final working-tree changes or commit being delivered. Report
remaining failures, retained failure diagnostics, and task-owned cleanup as
applicable. A build alone is not runtime or E2E evidence.
