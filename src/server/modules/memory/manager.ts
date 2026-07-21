import type {
  MemoryEntry,
  MemoryFeedbackInput,
  MemoryFeedbackOutcome,
  MemoryKind,
  MemoryProvider,
  MemoryRememberInput,
  MemoryScope,
  MemorySearchContext,
  MemorySearchInput,
  MemorySearchResult,
  MemorySource,
  MemoryStatus,
  MemoryUpdateInput
} from "./types.js";
import type { FeatureRow } from "../features/features-store.js";
import type { ProjectRow } from "../projects/projects-store.js";

const MEMORY_PROMPT_ENTRY_LIMIT = 12;
const MEMORY_PROMPT_ENTRY_MAX_CHARS = 900;

export class MemoryManager {
  constructor(private provider: MemoryProvider) {}

  replaceProvider(provider: MemoryProvider): void {
    this.provider = provider;
  }

  async remember(input: MemoryRememberInput): Promise<MemoryEntry> {
    return this.provider.remember(input);
  }

  async update(input: MemoryUpdateInput): Promise<MemoryEntry | null> {
    return this.provider.update(input);
  }

  async feedback(input: MemoryFeedbackInput): Promise<MemoryEntry | null> {
    return this.provider.feedback(input);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.provider.get(id);
  }

  async search(
    input: MemorySearchInput,
    context: MemorySearchContext = {}
  ): Promise<MemorySearchResult[]> {
    return this.provider.search(input, context);
  }

  async archive(id: string, metadata?: Record<string, unknown>): Promise<MemoryEntry | null> {
    return this.provider.archive(id, metadata);
  }

  async forget(id: string, metadata?: Record<string, unknown>): Promise<MemoryEntry | null> {
    return this.provider.forget(id, metadata);
  }

  async buildPromptSection(
    context: MemorySearchContext,
    opts: { limit?: number; maxEntryChars?: number } = {}
  ): Promise<string> {
    const limit = opts.limit ?? MEMORY_PROMPT_ENTRY_LIMIT;
    const maxEntryChars = opts.maxEntryChars ?? MEMORY_PROMPT_ENTRY_MAX_CHARS;
    const entries = await this.provider.listForPrompt(context, limit);
    if (entries.length === 0) return "";
    const lines = entries.map((entry) => {
      const prefix = [entry.scope, entry.kind].join("/");
      return `- [id: ${entry.id}] (${prefix}) ${limitPromptText(entry.content, maxEntryChars)}`;
    });
    return [
      "## Memory",
      "The following durable memories were activated for the current context.",
      ...lines,
      "Use memory_search for additional or more specific historical context before relying on memory.",
      "After relying on a memory, call memory_feedback with the exact id shown above or returned by memory_search. If a memory is irrelevant, stale, or wrong, call memory_feedback with that outcome plus a concrete note; the tool attaches source context automatically, and feedback is only an evidence signal that does not archive memories directly."
    ].join("\n");
  }

}

function limitPromptText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function defaultMemoryScopeForContext(input: {
  requestedScope?: MemoryScope | "context";
  project?: ProjectRow | null;
  feature?: FeatureRow | null;
}): MemoryScope {
  if (input.requestedScope && input.requestedScope !== "context") return input.requestedScope;
  if (input.feature) return "feature";
  if (input.project) return "project";
  return "global";
}

export const MEMORY_KINDS = ["episodic", "semantic", "preference", "procedural"] as const satisfies readonly MemoryKind[];
export const MEMORY_SCOPES = ["user", "global", "project", "feature"] as const satisfies readonly MemoryScope[];
export const MEMORY_STATUSES = ["available", "archived", "deleted"] as const satisfies readonly MemoryStatus[];
export const MEMORY_SOURCES = ["explicit_user", "agent_flush", "tool_result", "manual"] as const satisfies readonly MemorySource[];
export const MEMORY_FEEDBACK_OUTCOMES = ["used", "helpful", "irrelevant", "stale", "wrong"] as const satisfies readonly MemoryFeedbackOutcome[];
