import type { LlmCallFilters } from "../../src/server/modules/activity/llm-call-rows.js";
import type { LlmCallDetailDto } from "../../src/shared/api-contracts.js";

interface CallReader {
  listLlmCallSummaries(limit?: number, options?: LlmCallFilters): Array<{ id: string }>;
  getLlmCall(id: string): LlmCallDetailDto | null;
}

/** Recorded calls, newest first, each read whole (request, output, usage):
 *  the list Activity shows, then each call's detail. */
export function llmCallDetails(store: CallReader, limit = 50, filters: LlmCallFilters = {}): LlmCallDetailDto[] {
  return store.listLlmCallSummaries(limit, filters).map((call) => store.getLlmCall(call.id)!);
}
