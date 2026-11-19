import type { Database } from "bun:sqlite";
import { logError } from "../../platform/logger.js";
import { sliceHorizon } from "./activity-rollup.js";
import { keepSlices, type SliceRow } from "./slice-store.js";

/** Rows written in one turn of the loop: a few milliseconds of the server's thread. */
const KEEP_BATCH = 50;

export interface SliceKeeperOptions {
  batch?: number;
  /** Runs `run` in a later turn of the loop. */
  later?: (run: () => void) => void;
  log?: (message: string) => void;
}

/**
 * Keeps the slices an answer worked out. The answer is worked out on a
 * thread that only reads; the server's own connection is the one writer, so
 * the rows come back with the answer and are written here after it is sent,
 * a batch a turn, between the server's other work.
 */
export class SliceKeeper {
  readonly #db: Database;
  readonly #batch: number;
  readonly #later: (run: () => void) => void;
  readonly #log: (message: string) => void;
  #queue: SliceRow[] = [];
  #turnDue = false;
  #enabled = true;
  #waiting: Array<() => void> = [];

  constructor(db: Database, options: SliceKeeperOptions = {}) {
    this.#db = db;
    this.#batch = options.batch ?? KEEP_BATCH;
    this.#later = options.later ?? ((run) => { setImmediate(run); });
    this.#log = options.log ?? ((message) => logError("activity slices", message));
  }

  /** Whether answers may be worked out from the kept slices. */
  get enabled(): boolean {
    return this.#enabled;
  }

  keep(rows: readonly SliceRow[]): void {
    if (!this.#enabled || rows.length === 0) return;
    this.#queue.push(...rows);
    this.#turnLater();
  }

  /**
   * The kept slices gave, or would have given, another answer than the calls
   * do: nothing kept so far is trusted again, and until the next start every
   * answer is worked out from the calls. Said once.
   */
  off(reason: string): void {
    if (!this.#enabled) return;
    this.#enabled = false;
    this.#queue = [];
    this.#log(`answers are worked out from every call until the next start: ${reason}`);
    try {
      // Every slice kept so far was built below the new floor, and the
      // check of the slices against the calls is owed again.
      this.#db.prepare("update activity_rollup_state set seq = seq + 1, floor = seq + 1, checked = null where id = 1").run();
    } catch (error) {
      this.#log(`the kept slices could not be marked out of date: ${String(error)}`);
    }
  }

  /** Notes that a month's answer from the slices was found to be the one
   *  from every call, as `key` (checkedKey): that check is not made again
   *  under it. */
  checked(key: string): void {
    if (!this.#enabled) return;
    try {
      this.#db.prepare("update activity_rollup_state set checked = ? where id = 1").run(key);
    } catch (error) {
      if (!closedUnder(error)) this.#log(`the check made could not be noted: ${String(error)}`);
    }
  }

  /** Resolves once everything handed over is kept or dropped. */
  idle(): Promise<void> {
    if (!this.#turnDue) return Promise.resolve();
    return new Promise((resolve) => { this.#waiting.push(resolve); });
  }

  #turnLater(): void {
    if (this.#turnDue) return;
    this.#turnDue = true;
    this.#later(() => this.#turn());
  }

  #turn(): void {
    this.#turnDue = false;
    try {
      this.#queue = keepSlices(this.#db, this.#queue, sliceHorizon(Date.now()), this.#batch);
    } catch (error) {
      // Nothing is lost: a slice not kept is worked out again by the next
      // answer that needs it, and handed over again.
      this.#queue = [];
      if (!closedUnder(error)) this.#log(`slices could not be kept: ${String(error)}`);
    }
    if (this.#queue.length > 0) {
      this.#turnLater();
      return;
    }
    for (const resolve of this.#waiting.splice(0)) resolve();
  }
}

/** The database closed with a turn still due (the server stopping): there is
 *  nothing to keep into, and nothing to say. Bun names no code for it. */
function closedUnder(error: unknown): boolean {
  return error instanceof RangeError && error.message.includes("closed database");
}

const keepers = new WeakMap<Database, SliceKeeper>();

/** The one keeper of a database: its answers and its fill hand over to the same queue. */
export function sliceKeeperFor(db: Database): SliceKeeper {
  let keeper = keepers.get(db);
  if (!keeper) {
    keeper = new SliceKeeper(db);
    keepers.set(db, keeper);
  }
  return keeper;
}
