import type { FeatureChangesFileResponse, FeatureChangesResponse } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";
import { parseUnifiedDiff, type DiffHunk } from "@/lib/diff-parse";

export interface CachedDiff {
  hunks: DiffHunk[];
  truncated: boolean;
}

// Keep parsed patches only for the current list revision. The server limits
// each patch; also bound the number retained while browsing large changesets.
const MAX_CACHED_DIFFS = 20;

export class ChangesDiffCache {
  private readonly controller = new AbortController();
  private readonly completed = new Map<string, CachedDiff>();
  private readonly pending = new Map<string, Promise<CachedDiff>>();

  constructor(
    private readonly featureId: string,
    private readonly compare: FeatureChangesResponse["compare"]
  ) {}

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get(path: string): CachedDiff | undefined {
    return this.completed.get(path);
  }

  load(path: string): Promise<CachedDiff> {
    if (this.aborted) return Promise.reject(this.controller.signal.reason);
    const cached = this.completed.get(path);
    if (cached) {
      this.completed.delete(path);
      this.completed.set(path, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(path);
    if (pending) return pending;

    const request = this.fetchDiff(path).finally(() => this.pending.delete(path));
    this.pending.set(path, request);
    return request;
  }

  private async fetchDiff(path: string): Promise<CachedDiff> {
    const { signal } = this.controller;
    const res = await fetch(api.featureChangesFile(this.featureId, path, this.compare), { signal });
    if (!res.ok) throw new Error(`patch fetch failed (${res.status})`);
    const body = (await res.json()) as FeatureChangesFileResponse;
    // Some transports can finish reading a body after cancellation.
    signal.throwIfAborted();
    const result = { hunks: parseUnifiedDiff(body.patch), truncated: body.truncated };
    this.completed.set(path, result);
    if (this.completed.size > MAX_CACHED_DIFFS) {
      this.completed.delete(this.completed.keys().next().value!);
    }
    return result;
  }

  dispose(): void {
    this.controller.abort();
    this.pending.clear();
    this.completed.clear();
  }
}
