import type { MandateStore } from "../app/store.js";
import type { Config } from "../config.js";
import { createMemoryEmbedder } from "../modules/memory/embedding-provider.js";
import { LocalMemoryProvider } from "../modules/memory/local-provider.js";
import { MemoryManager } from "../modules/memory/manager.js";

export function createAgentRuntimeMemoryManager(input: {
  config: Config;
  store: MandateStore;
}) {
  return new MemoryManager(createAgentRuntimeMemoryProvider(input));
}

/** A memory that is read without counting as a use: a skill review reads
 *  memories for context, which is no agent's use of them at work (the uses
 *  are what the dream and the memory statistics weigh). */
export function createUncountedMemoryManager(input: { config: Config; store: MandateStore }): MemoryManager {
  return new (class extends MemoryManager {
    override recordUses(): void {}
  })(createAgentRuntimeMemoryProvider(input));
}

/** Loads the memory vectors ahead of the first search. Every provider on the
 *  store shares one cache, so this warms the agents' and the dream's alike. */
export function warmAgentMemoryVectors(input: { config: Config; store: MandateStore }): Promise<void> {
  return createAgentRuntimeMemoryProvider(input).warmVectors();
}

export function reloadAgentRuntimeMemoryManager(
  manager: MemoryManager,
  input: {
    config: Config;
    store: MandateStore;
  }
) {
  manager.replaceProvider(createAgentRuntimeMemoryProvider(input));
}

function createAgentRuntimeMemoryProvider(input: {
  config: Config;
  store: MandateStore;
}) {
  const embedder = createMemoryEmbedder(input.config);
  return new LocalMemoryProvider(input.store.db, { embedder });
}
