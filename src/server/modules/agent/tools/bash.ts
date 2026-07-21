import { statSync } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { assertReadInScope } from "../tool-scope.js";
import {
  nodeShellCommandRunner,
  type ShellCommandRunner
} from "../../../platform/process/shell-command-runner.js";

const params = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout: z.number().int().positive().max(600000).optional()
});

type BashResult = string;

export interface BashToolDeps {
  runner?: ShellCommandRunner;
}

export function createBashTool(deps: BashToolDeps = {}): ToolDefinition<z.infer<typeof params>, BashResult> {
  const runner = deps.runner ?? nodeShellCommandRunner;
  return {
    name: "bash",
    description:
      "Run any shell command in the user's login shell environment (same PATH " +
      "and env as their terminal). Returns a text transcript with stdout, " +
      "stderr, and exit code. This is the default way to run project commands; " +
      "use panes only for interactive CLIs and long-running processes. " +
      "cwd defaults to the project working directory. Default timeout 30s. " +
      "In feature scope, do not use bash to manage Mandate pane " +
      "lifecycle via raw tmux; use spawn_pane, send_keys, " +
      "read_pane, and kill_pane instead.",
    parameters: params,
    approval: "never",
    handler: async ({ command, cwd, timeout }, ctx) => {
      const requestedCwd =
        cwd ??
        (ctx.scope?.kind === "worker"
          ? (ctx.scope.feature?.workingDir ?? ctx.scope.project.workingDir)
          : (ctx.scope?.managerDir ?? process.cwd()));
      let effectiveCwd: string;
      try {
        effectiveCwd = assertReadInScope(requestedCwd, ctx.scope);
      } catch (err) {
        return formatBashResult({ stdout: "", stderr: (err as Error).message, exitCode: -1 });
      }
      // Pre-flight: ensure cwd is an actual directory before spawning. Node's
      // child_process emits a confusingly-worded ENOENT here that names the
      // executable when really the missing path is the cwd.
      try {
        const st = statSync(effectiveCwd);
        if (!st.isDirectory()) {
          return formatBashResult({ stdout: "", stderr: `cwd is not a directory: ${effectiveCwd}`, exitCode: -1 });
        }
      } catch {
        return formatBashResult({ stdout: "", stderr: `cwd does not exist: ${effectiveCwd}`, exitCode: -1 });
      }
      return formatBashResult(await runner.run(command, {
        cwd: effectiveCwd,
        timeoutMs: timeout ?? 30000
      }));
    }
  };
}

export const bashTool: ToolDefinition<z.infer<typeof params>, BashResult> = createBashTool();

function formatBashResult(result: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(`stdout:\n${result.stdout.replace(/\s+$/g, "")}`);
  }
  if (result.stderr) {
    parts.push(`stderr:\n${result.stderr.replace(/\s+$/g, "")}`);
  }
  parts.push(`exitCode: ${result.exitCode}`);
  return parts.join("\n");
}
