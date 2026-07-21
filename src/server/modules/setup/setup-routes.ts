import type { Hono } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { Config } from "../../config.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { getCodexAuthStatus } from "../codex/codex-auth-store.js";
import { buildSetupStatus } from "./setup-status.js";

export interface SetupRoutesDeps {
  config: Config;
  configFileExists: () => boolean;
  projects: ProjectsStore;
  probeTmux: () => { ok: boolean; error?: string | null };
}

export function mountSetupRoutes(app: Hono, deps: SetupRoutesDeps) {
  app.get(API_ROUTES.setupStatus, (c) => {
    const tmux = deps.probeTmux();
    const status = buildSetupStatus({
      config: deps.config,
      configFileExists: deps.configFileExists(),
      projectCount: deps.projects.listActive().length,
      tmuxAvailable: tmux.ok,
      tmuxError: tmux.error ?? null,
      codexAuthenticated: (providerName) =>
        getCodexAuthStatus(providerName).status === "authenticated"
    });
    return c.json(status);
  });
}
