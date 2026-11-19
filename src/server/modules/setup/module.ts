import type { MandateModule } from "../module.js";
import { commandFailureMessage } from "../../platform/process/command-runner.js";
import { tmuxCommand, type TmuxClient } from "../../platform/tmux/tmux.js";
import { mountSetupRoutes } from "./setup-routes.js";

export const setupModule: MandateModule = {
  id: "setup",
  mountRoutes: (app, { deps }) =>
    mountSetupRoutes(app, {
      config: deps.config,
      configFileExists: deps.configFileExists,
      projects: deps.projects,
      probeTmux: () => probeTmux(deps.tmuxClient)
    })
};

export async function probeTmux(client: TmuxClient): Promise<{ ok: boolean; error?: string | null }> {
  const result = await tmuxCommand(client, ["-V"], { timeout: 1500 });
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    error: commandFailureMessage(result, `tmux -V failed (status ${result.status ?? "unknown"})`)
  };
}
