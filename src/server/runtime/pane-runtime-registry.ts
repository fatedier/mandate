import type { PaneRuntime } from "./pane-runtime.js";
import { TmuxRuntime } from "./runtimes/tmux-runtime.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";

interface PaneRuntimeRegistryDeps {
  tmuxClient: TmuxClient;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  /** Optional notifier called when a tmux window's geometry changes
   *  (apply-fit / release-fit / resize). server.ts wires this to
   *  `poller.poll({ forceWindowIds: [id] })` so snapshot freshness is
   *  immediate instead of waiting up to pollIntervalMs. */
  onWindowChanged?: (windowId: string) => void;
}

export interface PaneRuntimeRegistry {
  tmux: PaneRuntime;
  /** Look up the runtime for a project by id. Throws on unknown project id. */
  forProject(projectId: string): PaneRuntime;
}

export function buildPaneRuntimes(deps: PaneRuntimeRegistryDeps): PaneRuntimeRegistry {
  const tmux = new TmuxRuntime({
    tmuxClient: deps.tmuxClient,
    projectsStore: deps.projectsStore,
    featuresStore: deps.featuresStore,
    onWindowChanged: deps.onWindowChanged
  });

  return {
    tmux,
    forProject(projectId: string): PaneRuntime {
      const project = deps.projectsStore.getById(projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      return tmux;
    }
  };
}
