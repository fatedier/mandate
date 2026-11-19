import { mountGitRoutes } from "./git-routes.js";
import type { MandateModule } from "../module.js";

export const gitModule: MandateModule = {
  id: "git",
  mountRoutes: (app, { deps }) => mountGitRoutes(app, {
    projects: deps.projects,
    workers: deps.workers,
    gitClient: deps.gitClient
  })
};
