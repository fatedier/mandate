import type { LivePresence } from "./presence.js";

/** A window counts as in use while visible, focused and touched this recently. */
export const IN_USE_INPUT_MS = 3 * 60_000;
/** A desktop window touched this recently keeps the user "at the desk". */
export const AT_DESK_MS = 5 * 60_000;
/** At the desk, the external channels wait this long for the user to see it. */
export const ESCALATE_AFTER_MS = 5 * 60_000;
/** A desktop window touched this recently keeps a notice on a page on screen
 *  waiting (see planDelivery). */
export const NEAR_MS = 10 * 60_000;
/** How long such a notice waits for the user to see it. */
export const HOLD_MS = 2 * 60_000;

export type DeliveryPlan =
  | { kind: "looking" }
  | { kind: "in-use"; toast: string[] }
  | { kind: "held"; until: Date }
  | { kind: "desk"; system: string[]; externalAt: Date }
  | { kind: "away"; system: string[] };

/** Whether a page shows a matter: its thread's page (a worker's owner's);
 *  Personal agent's page for its own matters; the New thread page for what its
 *  "Waiting on you" list shows (`listed`). */
export function matterShownBy(path: string, matterKey: string, owners: (workerId: string) => string | null, listed: (matterKey: string) => boolean): boolean {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  if (pathname === "/home") return listed(matterKey);
  const [kind, id = ""] = splitKey(matterKey);
  if (kind === "agent") return pathname === "/agent";
  if (kind !== "thread" && kind !== "worker") return false;
  const match = /^\/threads\/([^/]+)$/.exec(pathname);
  if (!match) return false;
  const threadId = decodeURIComponent(match[1]!);
  return kind === "thread" ? threadId === id : owners(id) === threadId;
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf(":");
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
}

/** Visible, focused and touched within IN_USE_INPUT_MS. */
export function windowInUse(client: Pick<LivePresence, "visible" | "focused" | "lastInputAt">, now: Date): boolean {
  return client.visible && client.focused && touchedWithin(client, now, IN_USE_INPUT_MS);
}

function touchedWithin(client: Pick<LivePresence, "lastInputAt">, now: Date, ms: number): boolean {
  if (!client.lastInputAt) return false;
  const at = Date.parse(client.lastInputAt);
  return Number.isFinite(at) && now.getTime() - at <= ms;
}

/** A system notification goes to a desktop window that can show one; the
 *  desktop app's only while its switch is on. Phones never get one. */
function canShowSystem(client: LivePresence, desktopAppOn: boolean): boolean {
  if (client.device !== "desktop" || !client.canShowSystem) return false;
  return client.shell === "browser" || desktopAppOn;
}

/** Where a notice on `matterKey` goes now. */
export function planDelivery(input: {
  matterKey: string;
  clients: readonly LivePresence[];
  now: Date;
  desktopAppOn: boolean;
  owners: (workerId: string) => string | null;
  listed: (matterKey: string) => boolean;
  /** False once a notice has waited: where it goes then. */
  hold?: boolean;
}): DeliveryPlan {
  const { now } = input;
  const using = input.clients.filter((client) => windowInUse(client, now));
  if (using.some((client) => matterShownBy(client.path, input.matterKey, input.owners, input.listed))) return { kind: "looking" };
  if (using.length > 0) return { kind: "in-use", toast: using.map((client) => client.windowId) };
  // The matter's page on screen in a desktop window not in use (behind
  // another window, or read without a touch): the user may be reading it, or
  // it may be covered — macOS reports a window under another app's maximized
  // one as visible. While the desk was touched lately, it waits a little for
  // them to see it.
  const desktops = input.clients.filter((client) => client.device === "desktop");
  if (input.hold !== false
    && desktops.some((client) => touchedWithin(client, now, NEAR_MS))
    && desktops.some((client) => client.visible && matterShownBy(client.path, input.matterKey, input.owners, input.listed))) {
    return { kind: "held", until: new Date(now.getTime() + HOLD_MS) };
  }
  const system = input.clients.filter((client) => canShowSystem(client, input.desktopAppOn)).map((client) => client.windowId);
  const atDesk = input.clients.some((client) => client.device === "desktop" && touchedWithin(client, now, AT_DESK_MS));
  if (atDesk) return { kind: "desk", system, externalAt: new Date(now.getTime() + ESCALATE_AFTER_MS) };
  return { kind: "away", system };
}
