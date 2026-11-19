import type { Config } from "../config.js";
import { setLlmStreamTrace } from "../modules/agent/llm-stream-diagnostics.js";
import { setLogLevel, setLogStacks } from "../platform/logger.js";

/** config.json's logging section, on this thread: at start and on every
 *  reload. The worker threads that log are told it from here (the model-call
 *  worker before a stream, the retention worker with each pass). */
export function applyLoggingConfig(logging: Config["logging"]): void {
  setLogLevel(logging.level);
  setLogStacks(logging.stacks);
  setLlmStreamTrace(logging.streamTrace);
}
