import type { PresenceReport } from "../../../shared/api/notifications.js";

/** A window not heard from for this long is gone: a few missed heartbeats,
 *  which a hidden tab's throttled timers may delay. */
export const PRESENCE_EXPIRY_MS = 150_000;

export type LivePresence = PresenceReport & { seenAt: Date };

/** The windows open now, as they last reported themselves. In memory: a
 *  restart forgets them, and they report again within a heartbeat. */
export class PresenceBook {
  private readonly clients = new Map<string, LivePresence>();

  report(report: PresenceReport, now: Date): void {
    if (report.gone) {
      this.clients.delete(report.windowId);
      return;
    }
    this.clients.set(report.windowId, { ...report, seenAt: now });
  }

  live(now: Date): LivePresence[] {
    for (const [id, client] of this.clients) {
      if (now.getTime() - client.seenAt.getTime() > PRESENCE_EXPIRY_MS) this.clients.delete(id);
    }
    return [...this.clients.values()];
  }
}
