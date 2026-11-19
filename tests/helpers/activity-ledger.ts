import type { ActivityLedgerDto } from "../../src/shared/api-contracts.js";

/** A window's ledger with nothing in it, for summaries a test does not read it from. */
export function emptyLedger(overrides: Partial<ActivityLedgerDto> = {}): ActivityLedgerDto {
  return {
    previousSpendMicros: null,
    days: [],
    agents: [],
    cache: { rows: [], expiredWithinHour: 0, medianExpiredIdleMs: null, wrote1h: false },
    tokens: { uncachedInputMicros: 0, cacheReadMicros: 0, cacheWriteMicros: 0, outputMicros: 0, reportedUnsplitMicros: 0 },
    wakes: [],
    priceDataDate: null,
    claudeWriteReadRatio: null,
    ...overrides
  };
}
