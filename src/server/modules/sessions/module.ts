import os from "node:os";
import { resolveDataDir } from "../../platform/fs/data-dir.js";
import { mountSessionsRoutes } from "./session-routes.js";
import { openShell } from "./shells-session.js";
import { initializeSessionsSchema } from "./schema.js";
import { SessionService } from "./session-service.js";
import { TerminalPinStore } from "./terminal-pins-store.js";
import { mountTerminalRoutes } from "./terminal-routes.js";
import type { MandateModule } from "../module.js";

export const sessionsModule: MandateModule = {
  id: "sessions",
  schema: [initializeSessionsSchema],
  mountRoutes: (app, { deps }) => {
    const sessionDeps = {
      projects: deps.projects,
      tmuxClient: deps.tmuxClient,
      getRawState: () => deps.poller.getRaw()
    };
    mountSessionsRoutes(app, sessionDeps);
    mountTerminalRoutes(app, {
      sessions: new SessionService(sessionDeps),
      pins: new TerminalPinStore(deps.store.db),
      tmuxClient: deps.tmuxClient,
      sse: deps.sse,
      getRawState: sessionDeps.getRawState,
      openShell: () => openShell({ tmuxClient: deps.tmuxClient, dataDir: resolveDataDir(), homeDir: os.homedir() }),
      refreshState: () => deps.poller.pollFresh()
    });
  }
};
