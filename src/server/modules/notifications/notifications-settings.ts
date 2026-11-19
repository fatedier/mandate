import type { Config } from "../../config.js";
import type { NotificationsSettings } from "../../../shared/settings.js";
import { newId } from "../../platform/ids.js";
import { isJsonObject, type JsonObject } from "../settings/config-normalizers.js";
import { sectionFor } from "../settings/config-patch-helpers.js";
import { CHANNEL_KINDS } from "./channels/index.js";

/** What Settings needs of a channel kind: its id, and which of its values
 *  are secrets (written from the page, never read back). */
export interface ChannelKindInfo {
  id: string;
  secretKeys: readonly string[];
}

const DEFAULT_KINDS: readonly ChannelKindInfo[] = CHANNEL_KINDS;
const NAME_MAX = 60;

/** The Notifications section as the Settings page draws it. A channel of a
 *  kind this build lacks shows no values: any of them could be a secret. */
export function notificationsSettings(config: Config, kinds: readonly ChannelKindInfo[] = DEFAULT_KINDS): NotificationsSettings {
  const section = config.notifications;
  return {
    linkBase: section.linkBase,
    desktopApp: section.desktopApp,
    channels: section.channels.map((channel) => {
      const kind = kinds.find((k) => k.id === channel.kind);
      const secrets = kind?.secretKeys ?? [];
      return {
        id: channel.id,
        kind: channel.kind,
        name: channel.name,
        enabled: channel.enabled,
        includeText: channel.includeText,
        values: kind ? Object.fromEntries(Object.entries(channel.values).filter(([key]) => !secrets.includes(key))) : {},
        secretsSaved: secrets.filter((key) => Boolean(channel.values[key]?.trim()))
      };
    })
  };
}

/**
 * A save from the page. `linkBase`: blank or null clears it, else an http(s)
 * address, kept without a trailing slash. `upsert`: a channel without an id
 * is added under a new one; with an id, that channel is changed. Its values:
 * a secret is set by a string, kept by "", removed by null; any other value
 * is set by a string and removed by "" or null; values left out are kept.
 * `remove`: channel ids. The file's own keys (telegramApiBase) are kept.
 */
export function applyNotificationsPatch(root: JsonObject, patch: unknown, kinds: readonly ChannelKindInfo[] = DEFAULT_KINDS): void {
  if (!isJsonObject(patch)) throw new Error("notification settings must be an object");
  const section = sectionFor(root, "notifications");
  if (Object.hasOwn(patch, "linkBase")) {
    const linkBase = normalizeLinkBase(patch.linkBase);
    if (linkBase) section.linkBase = linkBase;
    else delete section.linkBase;
  }
  if (Object.hasOwn(patch, "desktopApp")) {
    if (typeof patch.desktopApp !== "boolean") throw new Error("desktopApp must be true or false");
    if (patch.desktopApp) section.desktopApp = true;
    else delete section.desktopApp;
  }
  let channels = Array.isArray(section.channels) ? [...section.channels] : [];
  if (Object.hasOwn(patch, "remove")) {
    if (!Array.isArray(patch.remove) || !patch.remove.every((id) => typeof id === "string")) throw new Error("remove must list channel ids");
    const gone = new Set(patch.remove as string[]);
    channels = channels.filter((channel) => !(isJsonObject(channel) && typeof channel.id === "string" && gone.has(channel.id)));
  }
  if (Object.hasOwn(patch, "upsert")) {
    if (!Array.isArray(patch.upsert)) throw new Error("upsert must be a list of channels");
    for (const entry of patch.upsert) channels = upsertChannel(channels, entry, kinds);
  }
  if (channels.length > 0) section.channels = channels;
  else delete section.channels;
  if (Object.keys(section).length === 0) delete root.notifications;
}

function normalizeLinkBase(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string") throw new Error("Open links at must be an http or https address");
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Open links at must be an http or https address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Open links at must be an http or https address");
  return trimmed.replace(/\/+$/, "");
}

function upsertChannel(channels: unknown[], entry: unknown, kinds: readonly ChannelKindInfo[]): unknown[] {
  if (!isJsonObject(entry)) throw new Error("a channel must be an object");
  const kind = kinds.find((k) => k.id === entry.kind);
  if (!kind) throw new Error(`unknown notification channel kind: ${String(entry.kind)}`);
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) throw new Error("A channel needs a name");
  if (name.length > NAME_MAX) throw new Error(`A channel's name is at most ${NAME_MAX} characters`);
  if (typeof entry.enabled !== "boolean" || typeof entry.includeText !== "boolean") throw new Error("enabled and includeText must be true or false");
  if (!isJsonObject(entry.values)) throw new Error("a channel's values must be an object");

  const id = entry.id === undefined ? null : entry.id;
  if (id !== null && typeof id !== "string") throw new Error("a channel's id must be a string");
  const at = id === null ? -1 : channels.findIndex((channel) => isJsonObject(channel) && channel.id === id);
  if (id !== null && at < 0) throw new Error(`no notification channel ${id}`);
  const existing = at >= 0 ? channels[at] as JsonObject : null;
  // Another kind's values mean nothing to this one.
  const saved = existing && existing.kind === kind.id && isJsonObject(existing.values) ? existing.values : {};
  const values: JsonObject = { ...saved };
  for (const [key, value] of Object.entries(entry.values)) {
    if (value === null) {
      delete values[key];
      continue;
    }
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed) values[key] = trimmed;
    else if (!kind.secretKeys.includes(key)) delete values[key];
  }
  const next: JsonObject = { ...(existing ?? {}), id: id ?? newId("nch"), kind: kind.id, name, enabled: entry.enabled, includeText: entry.includeText, values };
  const copy = [...channels];
  if (at >= 0) copy[at] = next;
  else copy.push(next);
  return copy;
}
