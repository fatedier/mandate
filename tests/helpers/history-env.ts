import { freshStoresEnv, seedWorker, seedProject } from "./fixtures.js";

/** Project "Alpha" with one worker, "Login": `caller` is a manager
 *  thread, `thread` the worker's thread. */
export function historyEnv() {
  const env = freshStoresEnv("md-history-");
  const projectId = seedProject(env.projects, {
    name: "Alpha",
    workingDir: "/alpha",
    tmuxSessionName: "alpha"
  });
  const workerId = seedWorker(env.workers, projectId, {
    name: "Login",
    tmuxWindowName: "login"
  });
  const caller = env.agentStore.getOrCreateThread("manager", null);
  const thread = env.agentStore.getOrCreateThread("worker", workerId);
  return { ...env, projectId, workerId, caller, thread };
}
