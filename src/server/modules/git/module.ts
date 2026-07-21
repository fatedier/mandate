import { mountGitRoutes } from "./git-routes.js";
import type { MandateModule } from "../module.js";

export const gitModule: MandateModule = {
  id: "git",
  mountRoutes: (app, { deps }) => mountGitRoutes(app, {
    projects: deps.projects,
    features: deps.features,
    gitClient: deps.gitClient
  })
};
