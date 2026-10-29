import type {
  MemoryBrief,
  MemoryEntry,
  MemoryListFilter,
  MemoryProvider,
  MemoryRememberInput,
  MemoryScope,
  MemorySearchInput,
  MemorySearchResult,
  MemorySource,
  MemoryType,
  MemoryUpdateInput,
  MemoryUse,
  MemoryWriteTx
} from "./types.js";
import { logError } from "../../platform/logger.js";

export class MemoryManager {
  constructor(private provider: MemoryProvider) {}

  replaceProvider(provider: MemoryProvider): void {
    this.provider = provider;
  }

  remember(input: MemoryRememberInput): Promise<MemoryEntry> { return this.provider.remember(input); }
  update(input: MemoryUpdateInput): Promise<MemoryEntry | null> { return this.provider.update(input); }
  archive(id: string, metadata?: Record<string, unknown>): Promise<MemoryEntry | null> { return this.provider.archive(id, metadata); }
  writeIfUnchanged<T>(expected: ReadonlyArray<Pick<MemoryEntry, "id" | "updatedAt">>, write: (tx: MemoryWriteTx) => T): Promise<T | null> { return this.provider.writeIfUnchanged(expected, write); }
  get(id: string): Promise<MemoryEntry | null> { return this.provider.get(id); }
  search(input: MemorySearchInput): Promise<MemorySearchResult[]> { return this.provider.search(input); }
  listAvailable(filter: MemoryListFilter): MemoryEntry[] { return this.provider.listAvailable(filter); }
  listArchivedSince(filter: MemoryListFilter, sinceIso: string): MemoryEntry[] { return this.provider.listArchivedSince(filter, sinceIso); }
  availableVectors(): ReadonlyMap<string, Float64Array> | null { return this.provider.availableVectors(); }
  getBrief(scope: MemoryScope, projectId: string | null): MemoryBrief | null { return this.provider.getBrief(scope, projectId); }
  putBrief(brief: MemoryBrief): void { this.provider.putBrief(brief); }
  deleteBrief(scope: MemoryScope, projectId: string | null): void { this.provider.deleteBrief(scope, projectId); }
  listBriefs(): MemoryBrief[] { return this.provider.listBriefs(); }
  /** Notes uses for statistics. A use that cannot be noted is logged and
   *  dropped: what the memory was used for goes on regardless. */
  recordUses(uses: readonly MemoryUse[]): void {
    if (uses.length === 0) return;
    try {
      this.provider.recordUses(uses);
    } catch (err) {
      logError("memory uses", err);
    }
  }
}

export const MEMORY_SCOPES = ["user", "project"] as const satisfies readonly MemoryScope[];
export const MEMORY_TYPES = ["preference", "knowledge", "task"] as const satisfies readonly MemoryType[];
export const MEMORY_SOURCES = ["user", "agent", "extraction"] as const satisfies readonly MemorySource[];
