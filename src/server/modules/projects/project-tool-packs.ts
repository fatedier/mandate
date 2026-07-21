import { buildArchiveProjectTool } from "./tools/archive-project.js";
import { buildCreateProjectTool } from "./tools/create-project.js";
import { buildListProjectsTool } from "./tools/list-projects.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { ProjectsStore } from "./projects-store.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";

export function buildProjectToolPacks(input: {
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  sessionDataDir?: string;
  publishLifecycle: LifecyclePublisher;
}): ToolPack[] {
  return [
    toolPack("projects.catalog", ["manager"], [
      buildListProjectsTool({
        projectsStore: input.projectsStore,
        featuresStore: input.featuresStore
      })
    ]),
    toolPack("projects.lifecycle", ["manager"], [
      buildCreateProjectTool({
        projectsStore: input.projectsStore,
        featuresStore: input.featuresStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        sessionDataDir: input.sessionDataDir,
        broadcast: input.publishLifecycle
      }),
      buildArchiveProjectTool({
        projectsStore: input.projectsStore,
        featuresStore: input.featuresStore,
        tmuxClient: input.tmuxClient,
        sessionDataDir: input.sessionDataDir,
        broadcast: input.publishLifecycle
      })
    ])
  ];
}
