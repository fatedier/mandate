import type { Database } from "bun:sqlite";
import type { TerminalPinDto } from "../../../shared/api-contracts.js";

interface PinRow { pane_id: string; pane_pid: number; pinned_at: string }

/** The Terminals page's pins, shared by every device: in the order they were
 *  put in, a new one last. */
export class TerminalPinStore {
  constructor(private readonly db: Database) {}

  list(): TerminalPinDto[] {
    return this.db.prepare(`select pane_id, pane_pid, pinned_at from terminal_pins order by position is null, position, pinned_at, rowid`)
      .all()
      .map((row) => {
        const r = row as PinRow;
        return { paneId: r.pane_id, pid: r.pane_pid, pinnedAt: r.pinned_at };
      });
  }

  /** False when the pane is pinned already. A pin left on its id by the pane
   *  before it (another pid, not dropped yet) gives way: the new pane's pin
   *  goes at the end. */
  add(paneId: string, pid: number): boolean {
    return this.db.transaction(() => {
      // Removed and made again rather than updated: the new pane's pin goes
      // at the end. Pins with no place yet (an older binary made them) are
      // the first made: placed as they are listed, so it goes after them.
      this.db.prepare(`delete from terminal_pins where pane_id = ? and pane_pid <> ?`).run(paneId, pid);
      if (!this.allPlaced()) this.place(this.list());
      return this.db.prepare(`insert into terminal_pins (pane_id, pane_pid, pinned_at, position)
        values (?, ?, ?, (select coalesce(max(position), 0) + 1 from terminal_pins)) on conflict(pane_id) do nothing`)
        .run(paneId, pid, new Date().toISOString()).changes > 0;
    })();
  }

  /** Puts the pins in `order`, as a Terminals page shows them after a drag:
   *  the listed ones first, then any it did not list (one made meanwhile on
   *  another device) as they were. One not pinned, or pinned with another
   *  pid, is skipped. Whether any pin moved. */
  reorder(order: Array<{ paneId: string; pid: number }>): boolean {
    return this.db.transaction(() => {
      const before = this.list();
      const listed = order.flatMap((o) => before.filter((p) => p.paneId === o.paneId && p.pid === o.pid));
      const next = [...new Set(listed), ...before.filter((p) => !listed.includes(p))];
      const moved = next.some((p, i) => p !== before[i]);
      if (moved || !this.allPlaced()) this.place(next);
      return moved;
    })();
  }

  /** Each pin's place, in this order. */
  private place(pins: TerminalPinDto[]): void {
    const at = this.db.prepare(`update terminal_pins set position = ? where pane_id = ? and pane_pid = ?`);
    pins.forEach((p, i) => at.run(i + 1, p.paneId, p.pid));
  }

  private allPlaced(): boolean {
    return (this.db.prepare(`select count(*) as n from terminal_pins where position is null`).get() as { n: number }).n === 0;
  }

  remove(paneId: string): boolean {
    return this.db.prepare(`delete from terminal_pins where pane_id = ?`).run(paneId).changes > 0;
  }

  /** Drops each of `among` (pins as listed before tmux was asked) whose
   *  pane is not in `live`, by id and pid; a pin made or remade since stays.
   *  How many went. */
  dropMissing(live: Array<{ paneId: string; pid: number }>, among: TerminalPinDto[] = this.list()): number {
    const alive = new Set(live.map((p) => `${p.paneId}\u0000${p.pid}`));
    const del = this.db.prepare(`delete from terminal_pins where pane_id = ? and pane_pid = ? and pinned_at = ?`);
    let gone = 0;
    this.db.transaction(() => {
      for (const pin of among) {
        if (!alive.has(`${pin.paneId}\u0000${pin.pid}`)) gone += del.run(pin.paneId, pin.pid, pin.pinnedAt).changes;
      }
    })();
    return gone;
  }
}
