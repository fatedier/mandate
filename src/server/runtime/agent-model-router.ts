import type { MandateStore } from "../app/store.js";
import { modelSupportsInput, type AgentRoute, type Config } from "../config.js";
import { listedChatModelRef, managerRequestCheckChain, resolveModelSelection, managerStopCheckChain, memoryRepeatCheckChain } from "../config/model-resolution.js";
import { createAgentProvider } from "../modules/agent/llm-provider.js";
import { agentProviderConfigFromResolved } from "./agent-provider-config.js";
import { judgementCandidatesOf, type JudgementCandidate } from "../modules/manager-checks/judge.js";
import { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import { normalizeLogRequests } from "../modules/activity/llm-call-logging.js";
import type { AgentScope, AgentStore } from "../modules/agent/agent-store.js";
import type { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import { compressionApiMode } from "./agent-compression-llm.js";
import type { createAgentRuntimeLlmRecorders } from "./agent-llm-recorders.js";
import type { AgentProviderInstance } from "../modules/agent/llm-provider.js";
import type { createAgentRuntimeProviders } from "./agent-providers.js";
import { providerInstanceSupportsToolResultImages } from "./agent-scopes.js";

type ModelInput = Parameters<typeof modelSupportsInput>[2];

/** What the router reads. Getters, because a config reload replaces all
 *  three: the next call routes by the new ones. */
interface AgentModelRouterSources {
  config: () => Config;
  providers: () => ReturnType<typeof createAgentRuntimeProviders>;
  recorders: () => ReturnType<typeof createAgentRuntimeLlmRecorders>;
  store: MandateStore;
  /** The thread's scope; undefined for a thread that is gone (routed as a worker). */
  scopeOf: (threadId: string) => AgentScope | undefined;
  /** A subagent thread's parent, the thread whose agent started it, as its
   *  background task names it; undefined for any other thread, or a task
   *  that is gone. */
  parentOf: (threadId: string) => string | undefined;
  /** A subagent thread is a page subagent's. */
  isPageSubagent?: (threadId: string) => boolean;
  /** The model a thread was switched to in its composer (`provider/model`);
   *  null: its route's. */
  modelOverrideOf?: (threadId: string) => string | null;
}

/** The routes a thread's own turns and compaction run on. */
type ThreadRoute = Extract<AgentRoute, "manager" | "worker" | "global" | "subagent" | "page">;

/** The router's two thread lookups, read from the stores. */
export function threadRouteSources(stores: {
  agentStore: Pick<AgentStore, "getThreadById" | "threadModelOverride">;
  backgroundTasks: Pick<BackgroundTaskStore, "getByChildThread">;
}): Pick<AgentModelRouterSources, "scopeOf" | "parentOf" | "isPageSubagent" | "modelOverrideOf"> {
  return {
    modelOverrideOf: (threadId) => stores.agentStore.threadModelOverride(threadId),
    scopeOf: (threadId) => stores.agentStore.getThreadById(threadId)?.scope,
    parentOf: (threadId) => stores.backgroundTasks.getByChildThread(threadId)?.parentThreadId,
    isPageSubagent: (threadId) => stores.backgroundTasks.getByChildThread(threadId)?.type === "page"
  };
}

/** Which model, fallbacks and Activity recorder each kind of call a thread
 *  makes uses: a manager thread the manager's, Your agent's its own, a
 *  worker's the worker's. A subagent runs on the subagent route when that is
 *  set, and otherwise on the route of the agent that started it. Memory
 *  extraction runs on its own route, whatever the thread. */
export function createAgentModelRouter(sources: AgentModelRouterSources) {
  /** A thread that is gone, and a subagent whose task or parent is, runs as a worker. */
  const routeOf = (threadId: string): ThreadRoute => {
    const scope = sources.scopeOf(threadId);
    if (scope !== "subagent") return scope ?? "worker";
    // A page subagent on its own route when that is set, else as subagents run.
    if (sources.config().agent.pageRouteSet && sources.isPageSubagent?.(threadId)) return "page";
    if (sources.config().agent.subagentRouteSet) return "subagent";
    const parentThreadId = sources.parentOf(threadId);
    const parentScope = parentThreadId ? sources.scopeOf(parentThreadId) : undefined;
    return parentScope && parentScope !== "subagent" ? parentScope : "worker";
  };

  /** The model the thread runs on first: its own pick, or a subagent's on its
   *  parent's route its parent's. A subagent on a route of its own, a pick
   *  Settings no longer lists, and a decision model: none. */
  const pickOf = (threadId: string): string | null => {
    const owner = sources.scopeOf(threadId) === "subagent"
      ? (routeOf(threadId) === "subagent" || routeOf(threadId) === "page" ? undefined : sources.parentOf(threadId))
      : threadId;
    const ref = owner ? sources.modelOverrideOf?.(owner) ?? null : null;
    return ref ? listedChatModelRef(sources.config(), ref) : null;
  };

  /** Instances built for picks, per provider set: a config reload builds new ones. */
  const pickInstances = new WeakMap<object, Map<string, AgentProviderInstance>>();
  const pickInstance = (ref: string, reasoningEffort: AgentProviderInstance["meta"]["reasoningEffort"]): AgentProviderInstance | null => {
    const providers = sources.providers();
    let built = pickInstances.get(providers);
    if (!built) pickInstances.set(providers, built = new Map());
    const key = `${ref}\u0000${reasoningEffort}`;
    let instance = built.get(key);
    if (!instance) {
      const resolved = resolveModelSelection(sources.config(), { model: ref, reasoningEffort });
      if (!resolved.provider || !resolved.model) return null;
      instance = createAgentProvider(agentProviderConfigFromResolved(resolved));
      built.set(key, instance);
    }
    return instance;
  };

  const refOf = (candidate: AgentProviderInstance) => `${candidate.meta.providerName}/${candidate.meta.model}`;

  /** The thread's models in order: its pick at its route's effort, then its
   *  route's primary and fallbacks, each model once. */
  const chainFor = (threadId: string, provider: { meta: AgentProviderInstance["meta"]; candidates: AgentProviderInstance[] }) => {
    const ref = pickOf(threadId);
    const pick = ref ? pickInstance(ref, provider.meta.reasoningEffort) : null;
    if (!pick) return provider.candidates;
    return [pick, ...provider.candidates.filter((candidate) => refOf(candidate) !== ref)];
  };

  const route = (threadId: string) => {
    const providers = sources.providers();
    const recorders = sources.recorders();
    const routes = {
      manager: {
        provider: providers.managerProvider,
        wake: recorders.managerWakeRecorder,
        compression: recorders.compressionManagerRecorder
      },
      worker: {
        provider: providers.workerProvider,
        wake: recorders.workerWakeRecorder,
        compression: recorders.compressionWorkerRecorder
      },
      global: {
        provider: providers.globalProvider,
        wake: recorders.globalWakeRecorder,
        compression: recorders.compressionGlobalRecorder
      },
      subagent: {
        provider: providers.subagentProvider,
        wake: recorders.subagentWakeRecorder,
        compression: recorders.compressionSubagentRecorder
      },
      page: {
        provider: providers.pageProvider,
        wake: recorders.pageWakeRecorder,
        compression: recorders.compressionPageRecorder
      }
    } satisfies Record<ThreadRoute, unknown>;
    return routes[routeOf(threadId)];
  };

  /** A judgement's models, each with its own recorder. */
  const judgementCandidates = (chain: ReturnType<typeof managerRequestCheckChain>): JudgementCandidate[] =>
    judgementCandidatesOf(chain, (step) => new AgentLlmCallRecorder({
      store: sources.store,
      logRequests: normalizeLogRequests(sources.config().agent.logRequests),
      provider: step.provider,
      providerName: step.providerName,
      api: step.api,
      providerType: step.providerType,
      model: step.model,
      baseURL: step.baseURL || "",
      apiMode: step.kind === "decision" ? "decisions" : "streamText"
    }));

  /** A fallback model's own recorder; the primary's is the configured one. */
  const fallbackRecorder = (candidate: AgentProviderInstance, apiMode: string) =>
    new AgentLlmCallRecorder({
      store: sources.store,
      logRequests: normalizeLogRequests(sources.config().agent.logRequests),
      provider: candidate.meta.provider,
      providerName: candidate.meta.providerName,
      api: candidate.meta.api,
      providerType: candidate.meta.providerType,
      model: candidate.meta.model,
      baseURL: candidate.meta.baseURL || "",
      apiMode
    });

  const supportsInputOnRoute = (threadRoute: ThreadRoute, input: ModelInput) => {
    if (input === "text") return true;
    const config = sources.config();
    return modelSupportsInput(config, config.agent[threadRoute].modelRef, input);
  };
  /** By scope alone. A subagent's route depends on its thread, so asked by
   *  scope it answers as for a thread the router cannot place: a worker's. */
  const supportsInputForScope = (scope: AgentScope, input: ModelInput) =>
    supportsInputOnRoute(scope === "subagent" ? "worker" : scope, input);
  const supportsInputForThread = (threadId: string, input: ModelInput) => {
    if (input === "text") return true;
    const ref = pickOf(threadId);
    return ref ? modelSupportsInput(sources.config(), ref, input) : supportsInputOnRoute(routeOf(threadId), input);
  };

  return {
    llmForThread(threadId: string) {
      const { provider, wake } = route(threadId);
      const config = sources.config();
      // The route's own recorder files the route's primary; any other model,
      // a pick first among them, files its calls under its own name.
      const recorderOf = (candidate: AgentProviderInstance) =>
        candidate === provider.candidates[0] ? wake : fallbackRecorder(candidate, "streamText");
      const chain = chainFor(threadId, provider);
      const first = chain[0];
      return {
        model: first?.model ?? provider.model,
        llmCallRecorder: first ? recorderOf(first) : wake,
        candidates: chain.map((candidate) => ({
          model: candidate.model,
          meta: candidate.meta,
          supportsImageInput: modelSupportsInput(config, refOf(candidate), "image"),
          supportsToolResultImages: providerInstanceSupportsToolResultImages(candidate),
          llmCallRecorder: recorderOf(candidate)
        }))
      };
    },
    compressionForThread(threadId: string) {
      const { provider, compression } = route(threadId);
      const recorderOf = (candidate: AgentProviderInstance) =>
        candidate === provider.candidates[0] ? compression : fallbackRecorder(candidate, compressionApiMode(candidate.meta.provider));
      const chain = chainFor(threadId, provider);
      const first = chain[0] ?? provider;
      return {
        model: first.model,
        provider: first.meta.provider,
        reasoningEffort: first.meta.reasoningEffort,
        supportsReasoning: first.meta.supportsReasoning,
        recorder: chain[0] ? recorderOf(chain[0]) : compression,
        candidates: chain.map((candidate) => ({
          model: candidate.model,
          provider: candidate.meta.provider,
          reasoningEffort: candidate.meta.reasoningEffort,
          supportsReasoning: candidate.meta.supportsReasoning,
          recorder: recorderOf(candidate)
        }))
      };
    },
    /** Manager request check's models now, each with its own recorder; none, it is off. */
    managerRequestCheck(): JudgementCandidate[] {
      return judgementCandidates(managerRequestCheckChain(sources.config()));
    },
    /** Manager stop check's models now, the same way. */
    managerStopCheck(): JudgementCandidate[] {
      return judgementCandidates(managerStopCheckChain(sources.config()));
    },
    /** Memory extraction's models, and memory repeat check's (none while it
     *  is off), which reads each memory before it is stored. */
    memoryExtraction() {
      const provider = sources.providers().extractionProvider;
      const recorder = sources.recorders().memoryExtractionRecorder;
      return {
        candidates: provider.candidates.map((candidate, index) => ({
          model: candidate.model,
          provider: candidate.meta.provider,
          reasoningEffort: candidate.meta.reasoningEffort,
          supportsReasoning: candidate.meta.supportsReasoning,
          recorder: index === 0 ? recorder : fallbackRecorder(candidate, compressionApiMode(candidate.meta.provider))
        })),
        repeatCheck: judgementCandidates(memoryRepeatCheckChain(sources.config()))
      };
    },
    supportsInputForScope,
    supportsInputForThread,
    supportsToolResultImagesForThread(threadId: string) {
      const { provider } = route(threadId);
      const first = chainFor(threadId, provider)[0] ?? provider;
      return supportsInputForThread(threadId, "image") && providerInstanceSupportsToolResultImages(first);
    },
    /** The model a thread's route runs on first, as `provider/model`: what
     *  Default means in its composer. */
    routeModelRefFor(threadId: string): string {
      const { provider } = route(threadId);
      return refOf(provider.candidates[0] ?? provider);
    },
    /** The thread's pick as it runs now: null when it has none, or one
     *  Settings no longer lists. */
    pickFor: pickOf
  };
}
