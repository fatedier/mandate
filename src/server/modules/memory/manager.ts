import type {
  MemoryBrief,
  MemoryEntry,
  MemoryListFilter,
  MemoryProvider,
  MemoryRememberInput,
  MemoryScope,
  MemorySearchInput,
  MemorySearchResult,
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
  writeIfUnchanged<T>(expected: ReadonlyArray<Pick<MemoryEntry, "id" | "updatedAt">>, write: (tx: MemoryWriteTx) => T): Promise<T | null> { return this.provider.writeIfUnchanged(expected, write); }
  get(id: string): Promise<MemoryEntry | null> { return this.provider.get(id); }
  search(input: MemorySearchInput): Promise<MemorySearchResult[]> { return this.provider.search(input); }
  listAvailable(filter: MemoryListFilter): MemoryEntry[] { return this.provider.listAvailable(filter); }
  availableStamps(filter: MemoryListFilter): Array<Pick<MemoryEntry, "id" | "updatedAt">> { return this.provider.availableStamps(filter); }
  countAvailable(filter: MemoryListFilter): number { return this.provider.countAvailable(filter); }
  listArchivedSince(filter: MemoryListFilter, sinceIso: string): MemoryEntry[] { return this.provider.listArchivedSince(filter, sinceIso); }
  mostSearched(filter: MemoryListFilter, sinceIso: string, options: { min: number; limit: number }): Array<{ id: string; times: number }> { return this.provider.mostSearched(filter, sinceIso, options); }
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
