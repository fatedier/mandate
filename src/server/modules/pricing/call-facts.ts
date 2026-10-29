import { isRecord } from "../../../shared/guards.js";

/** What a response said about its own price, as it said it. Which of these is
 *  the spend depends on who sent it (`resolveCallFacts`). */
export interface CallFactCandidates {
  /** OpenRouter-style `usage.cost`. */
  usageCost?: number;
  isByok?: boolean;
  /** `usage.cost_details.upstream_inference_cost`. */
  upstreamCost?: number;
  /** A Vercel-style gateway's `gateway.marketCost` (Kilo passes it on). */
  marketCost?: number;
  /** The LiteLLM proxy's `x-litellm-response-cost` header, verbatim. */
  litellmHeader?: string;
  /** An OpenRouter Decisions response's `cost`. */
  decisionsCost?: number;
  /** Anthropic's `cache_creation.ephemeral_1h_input_tokens`. */
  cacheWrite1h?: number;
  /** Anthropic's `cache_creation.ephemeral_5m_input_tokens`: with the 1-hour
   *  count, how long the provider actually kept what was written. */
  cacheWrite5m?: number;
  /** The service tier the provider says it used. */
  serviceTier?: string;
}

export interface CallFacts {
  reportedMicros: number | null;
  reportedField: string | null;
  cacheWrite1hTokens: number | null;
  cacheWrite5mTokens: number | null;
  serviceTier: string | null;
}

/** Usage in the AI SDK's own shape, so the recorder reads it like any other. */
export interface UsageSoFar {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}

const LITELLM_COST_HEADER = "x-litellm-response-cost";

function money(value: unknown): number | undefined {
  const n = typeof value === "string" ? (value.trim() ? Number(value) : NaN) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function header(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

export class CallFactsCollector {
  private readonly noted: CallFactCandidates = {};
  private usage: UsageSoFar | null = null;

  candidates(): CallFactCandidates {
    return { ...this.noted };
  }

  hasAny(): boolean {
    return Object.keys(this.noted).length > 0;
  }

  usageSoFar(): UsageSoFar | null {
    return this.usage ? structuredClone(this.usage) : null;
  }

  /** A provider chunk as it came (streamText's `includeRawChunks`). */
  noteRaw(raw: unknown): void {
    if (!isRecord(raw)) return;
    // Anthropic: the prompt's usage arrives at the start of the stream.
    if (raw.type === "message_start" && isRecord(raw.message) && isRecord(raw.message.usage)) {
      const u = raw.message.usage;
      this.noteAnthropicUsage(u);
      const uncached = count(u.input_tokens) ?? 0;
      const read = count(u.cache_read_input_tokens) ?? 0;
      const write = count(u.cache_creation_input_tokens) ?? 0;
      this.usage = { inputTokens: uncached + read + write, inputTokenDetails: { cacheReadTokens: read, cacheWriteTokens: write } };
    }
    // Anthropic's message delta: a newer usage snapshot (the cache breakdown
    // can arrive here), and a Vercel-style gateway's cost.
    if (raw.type === "message_delta") {
      if (isRecord(raw.usage)) this.noteAnthropicUsage(raw.usage);
      if (isRecord(raw.provider_metadata)) this.noteGateway(raw.provider_metadata.gateway);
    }
    // Chat completions: usage, and an OpenRouter-style cost, on the final chunk.
    if (Array.isArray(raw.choices) && isRecord(raw.usage)) {
      this.noteCostUsage(raw.usage);
      const prompt = count(raw.usage.prompt_tokens);
      if (prompt !== undefined) {
        const details = isRecord(raw.usage.prompt_tokens_details) ? raw.usage.prompt_tokens_details : {};
        const cached = count(details.cached_tokens);
        this.usage = {
          inputTokens: prompt,
          ...(count(raw.usage.completion_tokens) !== undefined ? { outputTokens: count(raw.usage.completion_tokens) } : {}),
          ...(cached !== undefined ? { inputTokenDetails: { cacheReadTokens: cached } } : {})
        };
      }
    }
    // Responses: the completed response carries usage and the tier used.
    if (raw.type === "response.completed" && isRecord(raw.response)) {
      if (isRecord(raw.response.usage)) this.noteCostUsage(raw.response.usage);
      if (typeof raw.response.service_tier === "string") this.noted.serviceTier = raw.response.service_tier;
    }
    if (typeof raw.service_tier === "string") this.noted.serviceTier = raw.service_tier;
  }

  /** streamText's `finish-step` part: response headers and provider metadata. */
  noteFinishStep(part: Record<string, unknown>): void {
    const response = isRecord(part.response) ? part.response : {};
    const litellm = header(response.headers, LITELLM_COST_HEADER);
    if (litellm !== undefined) this.noted.litellmHeader = litellm;
    this.noteProviderMetadata(part.providerMetadata);
  }

  /** A whole result (generateText-shaped, or an OpenRouter Decisions response). */
  noteResult(result: unknown): void {
    if (!isRecord(result)) return;
    const response = isRecord(result.response) ? result.response : {};
    const litellm = header(response.headers, LITELLM_COST_HEADER);
    if (litellm !== undefined) this.noted.litellmHeader = litellm;
    this.noteProviderMetadata(result.providerMetadata);
    for (const usage of [result.usage, result.totalUsage]) {
      if (isRecord(usage) && isRecord(usage.raw)) {
        this.noteCostUsage(usage.raw);
        this.noteAnthropicUsage(usage.raw);
      }
    }
    // An OpenRouter Decisions response: keyed answers, and its cost in usage.
    if ((isRecord(result.answers) || Array.isArray(result.answers)) && isRecord(result.usage)) {
      const decisions = money(result.usage.cost);
      if (decisions !== undefined) this.noted.decisionsCost = decisions;
    }
  }

  private noteProviderMetadata(metadata: unknown): void {
    if (!isRecord(metadata)) return;
    if (isRecord(metadata.openai) && typeof metadata.openai.serviceTier === "string") this.noted.serviceTier = metadata.openai.serviceTier;
    if (isRecord(metadata.anthropic) && isRecord(metadata.anthropic.usage)) this.noteAnthropicUsage(metadata.anthropic.usage);
    this.noteGateway(metadata.gateway);
  }

  private noteAnthropicUsage(usage: Record<string, unknown>): void {
    if (typeof usage.service_tier === "string") this.noted.serviceTier = usage.service_tier;
    // A gateway answering in Messages (Kilo) puts its cost in the same usage.
    this.noteCostUsage(usage);
    const creation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
    const longWrites = creation ? count(creation.ephemeral_1h_input_tokens) : undefined;
    if (longWrites !== undefined) this.noted.cacheWrite1h = longWrites;
    const shortWrites = creation ? count(creation.ephemeral_5m_input_tokens) : undefined;
    if (shortWrites !== undefined) this.noted.cacheWrite5m = shortWrites;
  }

  private noteGateway(gateway: unknown): void {
    if (!isRecord(gateway)) return;
    const market = money(gateway.marketCost);
    if (market !== undefined) this.noted.marketCost = market;
  }

  private noteCostUsage(usage: Record<string, unknown>): void {
    const cost = money(usage.cost);
    if (cost !== undefined) this.noted.usageCost = cost;
    if (typeof usage.is_byok === "boolean") this.noted.isByok = usage.is_byok;
    const details = isRecord(usage.cost_details) ? usage.cost_details : null;
    const upstream = details ? money(details.upstream_inference_cost) : undefined;
    if (upstream !== undefined) this.noted.upstreamCost = upstream;
  }
}

/** Whole micro-dollars, rounded as pricing rounds: at 12 significant digits
 *  first, so a half is not lost to float error. */
const toMicros = (usd: number) => Math.round(Number((usd * 1_000_000).toPrecision(12)));

/** Kilo's own host (or one under it), whatever type its connection was
 *  given: a custom connection pointed at Kilo gets Kilo's `cost` too. */
function isKiloAddress(baseURL: string | null): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "kilo.ai" || host.endsWith(".kilo.ai");
  } catch {
    return false;
  }
}

/**
 * The reported spend, by who reported it. Kilo's top-level `cost` is its own
 * fee (about 5% of upstream, $0 with the user's own key), so for Kilo only the
 * upstream or market cost counts. OpenRouter's `cost` is what it charged; with
 * the user's own key the upstream cost is billed on top. LiteLLM's header is
 * a number or nothing.
 */
export function resolveCallFacts(c: CallFactCandidates, providerType: string, baseURL: string | null = null): CallFacts {
  let reportedMicros: number | null = null;
  let reportedField: string | null = null;
  if (providerType === "kilo" || isKiloAddress(baseURL)) {
    if (c.upstreamCost !== undefined) {
      reportedMicros = toMicros(c.upstreamCost);
      reportedField = "upstream_inference_cost";
    } else if (c.marketCost !== undefined) {
      reportedMicros = toMicros(c.marketCost);
      reportedField = "gateway.marketCost";
    }
  } else if (c.usageCost !== undefined) {
    if (c.isByok === true && c.upstreamCost !== undefined) {
      reportedMicros = toMicros(c.usageCost + c.upstreamCost);
      reportedField = "usage.cost+upstream_inference_cost";
    } else {
      reportedMicros = toMicros(c.usageCost);
      reportedField = "usage.cost";
    }
  }
  if (reportedField === null && c.litellmHeader !== undefined) {
    const value = money(c.litellmHeader);
    if (value !== undefined) {
      reportedMicros = toMicros(value);
      reportedField = LITELLM_COST_HEADER;
    }
  }
  if (reportedField === null && c.decisionsCost !== undefined) {
    reportedMicros = toMicros(c.decisionsCost);
    reportedField = "decisions.cost";
  }
  return {
    reportedMicros,
    reportedField,
    cacheWrite1hTokens: c.cacheWrite1h ?? null,
    cacheWrite5mTokens: c.cacheWrite5m ?? null,
    serviceTier: c.serviceTier ?? null
  };
}
