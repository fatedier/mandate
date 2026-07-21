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
