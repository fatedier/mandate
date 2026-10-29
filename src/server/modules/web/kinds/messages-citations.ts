import { mapEventStreamData } from "../../llm/event-stream.js";

/**
 * A Messages stream's web search citation (`web_search_result_location`) as
 * some gateways send it: without `cited_text` and `encrypted_index`, which
 * Anthropic always includes and @ai-sdk/anthropic requires, so the whole
 * search failed on it. Model search reads a citation's page and its cited
 * text, and sends nothing back (only a later turn reads `encrypted_index`):
 * a missing one is given as empty, and every other event passes as it came.
 */
export function withCompleteCitations(base?: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    // The global fetch as it is at each call (a test or a wrapper may replace it).
    mapEventStreamData(await (base ?? globalThis.fetch)(input, init), completeCitationData)) as typeof fetch;
}

function completeCitationData(data: string): string {
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return data;
  }
  const delta = record(record(event)?.delta);
  const citation = record(delta?.citation);
  if (delta?.type !== "citations_delta" || citation?.type !== "web_search_result_location") return data;
  if (typeof citation.cited_text === "string" && typeof citation.encrypted_index === "string") return data;
  return JSON.stringify({
    ...(event as Record<string, unknown>),
    delta: { ...delta, citation: { ...citation, cited_text: citation.cited_text ?? "", encrypted_index: citation.encrypted_index ?? "" } }
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
