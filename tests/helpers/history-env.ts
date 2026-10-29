import { freshStoresEnv, seedFeature, seedProject } from "./fixtures.js";

/** Project "Alpha" with one feature, "Login": `caller` is the overview
 *  (manager) thread, `thread` the feature's worker thread. */
export function historyEnv() {
  const env = freshStoresEnv("md-history-");
  const projectId = seedProject(env.projects, {
    name: "Alpha",
    workingDir: "/alpha",
    tmuxSessionName: "alpha"
  });
  const featureId = seedFeature(env.features, projectId, {
    name: "Login",
    tmuxWindowName: "login"
  });
  const caller = env.agentStore.getOrCreateThread("manager", null);
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  return { ...env, projectId, featureId, caller, thread };
}
