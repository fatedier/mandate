import { streamText, type ToolSet } from "ai";
import type { Nodes } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { REASONING_EFFORT_OPTIONS, REASONING_EFFORT_VALUES, type ReasoningEffort } from "../../../../shared/settings.js";
import type { ResolvedProviderConfig } from "../../../config.js";
import { resolveModelSelection } from "../../../config/model-resolution.js";
import { agentProviderConfigFromResolved } from "../../../runtime/agent-provider-config.js";
import { createAgentProvider } from "../../agent/llm-provider.js";
import { AgentLlmCallRecorder } from "../../activity/llm-call-recorder.js";
import { llmAttemptMetadata, runLlmCandidates } from "../../llm/run-candidates.js";
import { providerOptionsWithReasoningForAiSdk, reasoningForAiSdk } from "../../llm/reasoning.js";
import { providerModelsWithBuiltins } from "../../settings/provider-models.js";
import type { Config } from "../../../config.js";
import { errorText } from "../../../../shared/error-text.js";
import { MAX_SEARCH_RESULTS, NO_ANSWER_IN_TIME, SearchFailure, type SearchFindings, type SearchItem, type SearchKind } from "../search-kind.js";
import { withCompleteCitations } from "./messages-citations.js";

export const MODEL_SEARCH_INSTRUCTIONS =
  "Search the web for what is asked below and answer from what you find. Name the pages you used. If the search finds nothing reliable, say so instead of answering from memory.";

/** The API a model is served on, for the two that carry a hosted search:
 *  OpenAI's Responses (openai, codex, a custom provider's default) and
 *  Anthropic's Messages (anthropic, a custom provider's Messages model at its
 *  own address). Keys are not checked: one may come from the environment. */
/** Every model the installation's providers list (codex's built-in ones
 *  included), as refs: what the Settings page offers, and all a search may use. */
export function listedModelRefs(config: Config): string[] {
  return Object.entries(config.models.providers).flatMap(([name, provider]) =>
    providerModelsWithBuiltins(provider).map((model) => `${name}/${model.id}`));
}

export function searchApiOf(model: ResolvedProviderConfig): "responses" | "messages" | null {
  // A decision model only answers typed questions: it has no search.
  if (!model.modelRef || !model.model || model.kind === "decision") return null;
  // A Kilo model runs as the family of the API Kilo tags it with; whether
  // Kilo passes the hosted search tools through is untested: none.
  if (model.providerType === "kilo") return null;
  switch (model.provider) {
    case "openai":
    case "codex":
      return "responses";
    case "openai-compatible":
      return model.protocol === "chat" ? null : "responses";
    case "anthropic":
      return model.providerType === "openai-compatible" && !model.baseURL ? null : "messages";
    default:
      return null;
  }
}

/**
 * Model search: one call to the chosen model with only its provider's hosted
 * search, told to search but left to call it (a provider may keep a forced
 * tool forced at every step and never write an answer), recorded as the
 * other model calls are. A reply with no search in it is no result. What it
 * wrote is the answer; the pages it cited, then the ones it consulted, are
 * the results. Its state — encrypted results, paused turns — ends with the
 * call.
 */
export const modelSearchKind: SearchKind = {
  id: "model",
  label: "Model search",
  description: "A model's built-in search, through its provider.",
  fields: [
    {
      key: "model",
      type: "model",
      label: "Model",
      description: "Only models on the Responses or Messages API can search.",
      required: true,
      accepts: (model) => searchApiOf(model) !== null,
      note: (model) => (searchApiOf(model) === "messages" ? "Messages" : "Responses")
    },
    {
      key: "api",
      type: "choice",
      label: "API",
      description: "For a custom provider's model, which of the two it searches on. How agents call the model does not change.",
      required: false,
      options: [
        { value: "model", label: "As the model is set" },
        { value: "responses", label: "Responses" },
        { value: "messages", label: "Messages" }
      ],
      defaultValue: "model"
    },
    {
      key: "effort",
      type: "choice",
      label: "Reasoning effort",
      required: false,
      options: REASONING_EFFORT_OPTIONS,
      defaultValue: "low"
    }
  ],
  describe: (setup) => `Model search · ${setup.model ?? ""}`,
  async search(setup, query, ctx) {
    const ref = setup.model ?? "";
    const effort = (REASONING_EFFORT_VALUES as readonly string[]).includes(setup.effort ?? "") ? (setup.effort as ReasoningEffort) : "low";
    const api = setup.api === "responses" || setup.api === "messages" ? setup.api : undefined;
    const resolved = resolveModelSelection(ctx.config, { model: ref, reasoningEffort: effort }, api ? { api } : {});
    // A model taken off its provider's list no longer says which API it is
    // on: it is not searched with.
    const searchApi = listedModelRefs(ctx.config).includes(ref) ? searchApiOf(resolved) : null;
    if (!searchApi) throw new SearchFailure(`${ref} is not on the Responses or Messages API`);
    // One call with nothing to replay: the package with the hosted web_search
    // tool; on Messages, a gateway's incomplete citations completed.
    const candidate = createAgentProvider({
      ...agentProviderConfigFromResolved(resolved),
      responsesSdk: "openai",
      ...(searchApi === "messages" ? { fetch: withCompleteCitations() } : {})
    });
    const { meta } = candidate;
    const recorder = ctx.store
      ? new AgentLlmCallRecorder({
          store: ctx.store,
          logRequests: ctx.config.agent.logRequests as ConstructorParameters<typeof AgentLlmCallRecorder>[0]["logRequests"],
          provider: meta.provider,
          providerName: meta.providerName,
          api: meta.api,
          providerType: meta.providerType,
          model: meta.model,
          baseURL: meta.baseURL,
          apiMode: "streamText"
        })
      : null;
    return runLlmCandidates({
      candidates: [candidate],
      signal: ctx.signal,
      wait: ctx.wait,
      attempt: async (current, at) => {
        // Written at the start and again, with the pages, at the end: the
        // finish replaces what the start wrote.
        const attemptMeta = llmAttemptMetadata(at, {});
        const callId = recorder?.startCall({
          purpose: "web_search",
          scopeType: ctx.record.scopeType,
          scopeId: ctx.record.scopeId,
          requestPayload: { query },
          metadata: attemptMeta
        }) ?? null;
        const startedAt = Date.now();
        let usage: unknown;
        // The pages the stream named as it went: a failed attempt is recorded
        // with them, however it failed — an error event, or a dropped stream.
        const seen: SearchPart[] = [];
        try {
          const reply = await streamOnce(current.model, searchApi, effort, meta, query, ctx.signal, ctx.timeoutMs, seen);
          usage = reply.usage;
          // The provider's own error comes first.
          if ("error" in reply) throw reply.error;
          const found = findingsOf(reply);
          recorder?.finishCall(callId, {
            status: "succeeded",
            result: { text: found.answer ?? "", toolCalls: [] },
            usage,
            metadata: { ...attemptMeta, sources: found.results.map((r) => r.url) },
            latencyMs: Date.now() - startedAt
          });
          return found;
        } catch (error) {
          recorder?.finishCall(callId, { status: "failed", error, usage, metadata: { ...attemptMeta, sources: pagesOf(seen).map((r) => r.url) }, latencyMs: Date.now() - startedAt });
          throw error;
        }
      }
    });
  }
};

interface Reply {
  text: string;
  content: ContentPart[];
  usage: unknown;
  /** What the stream reported besides its parts. */
  error?: unknown;
}

async function streamOnce(
  model: Parameters<typeof streamText>[0]["model"],
  api: "responses" | "messages",
  effort: ReasoningEffort,
  meta: { provider: string; supportsReasoning?: boolean },
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
  seen: SearchPart[]
): Promise<Reply> {
  const tools: ToolSet = api === "responses"
    ? { web_search: openai.tools.webSearch({}) }
    : { web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }) };
  // Messages: thinking stays off, as it was while the tool was forced.
  const reasoning = api === "responses" ? reasoningForAiSdk(effort, meta.supportsReasoning) : undefined;
  const providerOptions = api === "responses"
    ? providerOptionsWithReasoningForAiSdk(undefined, meta.provider, meta.supportsReasoning)
    : { anthropic: { thinking: { type: "disabled" as const } } };
  let streamError: { error: unknown } | null = null;
  // The search's own time, as every backend's (SEARCH_TIMEOUT_MS): a timer of its own, so a
  // stop and a timeout are told apart.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const result = streamText({
    model,
    system: MODEL_SEARCH_INSTRUCTIONS,
    prompt: query,
    tools,
    toolChoice: "auto",
    ...(reasoning ? { reasoning } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    maxRetries: 0,
    abortSignal: AbortSignal.any([signal, timeout.signal]),
    onChunk: ({ chunk }) => {
      // A text block's citations come with its end: kept, for a stream cut off before the result.
      if (chunk.type === "source" || chunk.type === "tool-result" || chunk.type === "tool-error" || chunk.type === "text-end") seen.push(chunk as SearchPart);
    },
    onError: ({ error }) => {
      streamError ??= { error };
    }
  });
  let settled: [string, Awaited<typeof result.content>, unknown];
  try {
    settled = await Promise.all([result.text, result.content, result.totalUsage]);
  } catch (error) {
    // streamText reports the provider's own error only to onError (an abort
    // is not reported there). When the stream sent one, it is the attempt's
    // error, whatever came after it (no output, a body that dropped, the
    // timeout): it says why, and whether to try again. A stop stays a stop.
    if (signal.aborted) throw error;
    const recorded = streamError as { error: unknown } | null;
    if (recorded) throw recorded.error;
    if (timeout.signal.aborted) throw new SearchFailure(NO_ANSWER_IN_TIME);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const [text, content, usage] = settled;
  // An error the stream reported after its answer is the call's too: the
  // attempt throws it before reading the findings.
  const reported = streamError as { error: unknown } | null;
  return { text, content, usage, ...(reported ? { error: reported.error } : {}) };
}

/** What a reply found, or why it is no search result. */
function findingsOf({ text, content }: Reply): SearchFindings {
  const searches = content.filter((part) => (part.type === "tool-result" || part.type === "tool-error") && part.toolName === "web_search");
  if (searches.length === 0) throw new SearchFailure("the model answered without searching", undefined, text.trim() || undefined);
  const failed = searches.find((part) => part.type === "tool-error" || isSearchError(part));
  if (failed && searches.every((part) => part.type === "tool-error" || isSearchError(part))) {
    throw new SearchFailure(searchErrorText(failed));
  }
  const answer = text.trim();
  return { ...(answer ? { answer } : {}), results: pagesOf(content, answer) };
}

type ContentPart = Awaited<ReturnType<typeof streamText>["content"]>[number];
/** What a search's pages are read from: the result's content, or the parts
 *  seen in the stream (a text block's end carries its citations). */
type SearchPart = ContentPart | { type: "text-end"; citations?: unknown };

function isSearchError(part: ContentPart): boolean {
  if (part.type !== "tool-result") return false;
  const output = part.output as { type?: unknown } | null;
  return Boolean(output && typeof output === "object" && output.type === "web_search_tool_result_error");
}

/** The provider's code for a failed hosted search, as the SDK carries it
 *  (an error part's error, or a result's output), else its text. */
function searchErrorText(part: ContentPart): string {
  const value = part.type === "tool-error" ? (part as { error?: unknown }).error : (part as { output?: unknown }).output;
  const code = value && typeof value === "object" ? (value as { errorCode?: unknown }).errorCode : undefined;
  if (typeof code === "string" && code) return code;
  return errorText(value, "the search failed");
}

/** Cited pages in the order first cited, then consulted ones (pages the
 *  search returned, opened or looked in), once each. A citation is on the
 *  text it supports (a text part, or a text block's end in the stream), with
 *  the passage when the provider gives one; the search's own results come as
 *  sources (Messages' with the page's age) and in its tool result. With none
 *  of those, the pages the answer links to: a provider may name its pages
 *  only in its text (DeepSeek's Responses gives no citations and no source list). */
function pagesOf(content: SearchPart[], answer = ""): SearchItem[] {
  const cited: SearchItem[] = [];
  const consulted: SearchItem[] = [];
  const seen = new Map<string, SearchItem>();
  const add = (list: SearchItem[], address: string, title: string | undefined, excerpt: string, published?: string) => {
    const url = pageAddress(address);
    if (!url) return;
    const known = seen.get(url);
    if (known) {
      if (!known.title && title) known.title = title;
      if (!known.excerpt && excerpt) known.excerpt = excerpt;
      if (!known.published && published) known.published = published;
      return;
    }
    const item: SearchItem = { title: title ?? "", url, excerpt, ...(published ? { published } : {}) };
    seen.set(url, item);
    list.push(item);
  };
  for (const part of content) {
    if (part.type !== "text" && part.type !== "text-end") continue;
    const citations = (part as { citations?: unknown }).citations;
    for (const citation of Array.isArray(citations) ? citations : []) {
      const source = (citation as { source?: { sourceType?: unknown; url?: unknown; title?: unknown } } | null)?.source;
      if (source?.sourceType !== "url" || typeof source.url !== "string") continue;
      const citedText = (citation as { citedText?: unknown }).citedText;
      add(cited, source.url, typeof source.title === "string" ? source.title : undefined, typeof citedText === "string" ? citedText : "");
    }
  }
  for (const part of content) {
    if (part.type === "source" && part.sourceType === "url") {
      const pageAge = (part.providerMetadata?.anthropic as { pageAge?: unknown } | undefined)?.pageAge;
      add(consulted, part.url, part.title, "", typeof pageAge === "string" ? pageAge : undefined);
    }
    if (part.type === "tool-result" && part.toolName === "web_search") {
      const output = part.output as { sources?: unknown; action?: { type?: unknown; url?: unknown } } | null;
      for (const source of Array.isArray(output?.sources) ? output.sources : []) {
        if (source && typeof source === "object" && (source as { type?: unknown }).type === "url" && typeof (source as { url?: unknown }).url === "string") {
          add(consulted, (source as { url: string }).url, undefined, "");
        }
      }
      const opened = output?.action?.type === "openPage" || output?.action?.type === "findInPage";
      if (opened && typeof output.action?.url === "string") add(consulted, output.action.url, undefined, "");
    }
  }
  if (cited.length === 0 && consulted.length === 0) {
    for (const link of answerLinks(answer)) add(cited, link.url, link.title, "");
  }
  return [...cited, ...consulted].slice(0, MAX_SEARCH_RESULTS);
}

/** Markdown as the chat reads it, autolinked addresses included. */
const markdown = unified().use(remarkParse).use(remarkGfm);

/** The pages an answer links to, in order: its links and link definitions,
 *  each with its words as the title unless they are the address itself. */
function answerLinks(answer: string): Array<{ url: string; title: string }> {
  if (!answer) return [];
  const links: Array<{ url: string; title: string }> = [];
  const walk = (node: Nodes) => {
    if (node.type === "link" || node.type === "definition") {
      const words = node.type === "link" ? toString(node).trim() : "";
      links.push({ url: node.url, title: /^https?:\/\//i.test(words) ? "" : words });
    }
    if ("children" in node) for (const child of node.children) walk(child as Nodes);
  };
  walk(markdown.parse(answer));
  return links;
}

/** A page's address as the page has it, or null for one that is not a web
 *  page's: without the code a provider adds after it, which no page has —
 *  DeepSeek's "#ws_call_id=call_02", or numbers repeated ("#1#1"). One
 *  number after "#" is kept: it can be the page's own anchor (a comment on a
 *  thread). */
function pageAddress(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return /^#(?:ws_call_id=.*|\d+(?:#\d+)+)$/.test(url.hash) ? address.slice(0, address.indexOf("#")) : address;
}
