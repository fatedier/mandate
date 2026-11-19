import type { Database } from "bun:sqlite";
import { errorText } from "../../../shared/error-text.js";
import type { ProviderConfig } from "../../config/types.js";
import { logError } from "../../platform/logger.js";
import type { PriceCatalog } from "../pricing/catalog.js";
import { buildId } from "../../platform/build-id.js";
import { checkedKey, rollupInputs, type FillResult } from "./activity-rollup.js";
import { fillActivityAway, type FillRequest } from "./activity-summary-away.js";
import { sliceKeeperFor, type SliceKeeper } from "./slice-keeper.js";

export interface ActivityFillDeps {
  db: Database;
  /** The price lists in use; null prices nothing. */
  catalog: () => PriceCatalog | null;
  providers: () => Record<string, ProviderConfig>;
  /** Whether the pricing pass has looked at the settings in use and has
   *  nothing left to write into stored calls (PricingPass.idle). */
  pricingIdle: () => boolean;
  keeper?: SliceKeeper;
  /** Works the slices out off this thread (fillActivityAway). */
  fill?: (request: FillRequest) => Promise<FillResult>;
  now?: () => number;
  /** Which build this is (buildId): a check passed under another is made again. */
  build?: string;
  log?: (message: string) => void;
}

/**
 * Works the Activity slices out ahead of the page: after a start, the hours
 * no answer has kept yet; after the price lists or a connection's price
 * settings change, all of them again. Without it the first open after such
 * a change would wait for a month of calls once. The first fill of a new
 * build also checks the slices against every call (fillActivitySlices).
 *
 * `check()` is called on a timer. A fill runs when none has run under the
 * settings in use in this process and the pricing pass is idle: it has
 * looked at those settings and has nothing left to write into old calls.
 * While it prices calls again, each batch puts slices out of date and a
 * fill would be thrown away. One at a time, off the server's thread.
 */
export class ActivityFill {
  readonly #deps: ActivityFillDeps;
  readonly #keeper: SliceKeeper;
  readonly #log: (message: string) => void;
  /** The settings the last fill ran under. */
  #filled: string | null = null;
  #running: Promise<void> | null = null;

  constructor(deps: ActivityFillDeps) {
    this.#deps = deps;
    this.#keeper = deps.keeper ?? sliceKeeperFor(deps.db);
    this.#log = deps.log ?? ((message) => logError("activity slices", message));
  }

  /** Never throws: it runs on a timer of the server's. */
  check(): void {
    try {
      if (this.#running || !this.#keeper.enabled) return;
      const catalog = this.#deps.catalog();
      const providers = this.#deps.providers();
      const inputs = rollupInputs(catalog, providers);
      if (inputs === this.#filled || !this.#deps.pricingIdle()) return;
      const fill = this.#deps.fill ?? fillActivityAway;
      const checked = checkedKey(inputs, this.#deps.build ?? buildId());
      this.#running = fill({ dbPath: this.#deps.db.filename, providers, prices: catalog?.sources() ?? null, inputs, checked, now: (this.#deps.now ?? Date.now)() })
        .then((result) => this.#filledWith(inputs, checked, result), (error) => {
          // Left until the settings change or the next start: the answers
          // go on working out and keeping the slices they need.
          this.#filled = inputs;
          this.#log(`the slices could not be worked out ahead: ${errorText(error)}`);
        })
        .finally(() => { this.#running = null; });
    } catch (error) {
      this.#log(`the slices could not be looked at: ${errorText(error)}`);
    }
  }

  /** Resolves when the fill under way, if one is, has ended. */
  settled(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  #filledWith(inputs: string, checked: string, { built, compared }: FillResult): void {
    this.#filled = inputs;
    if (compared && !compared.same) {
      this.#keeper.off(`a month's answer from the slices is not the one from every call; they part at ${compared.where}`);
      return;
    }
    this.#keeper.keep(built);
    if (compared) this.#keeper.checked(checked);
  }
}
