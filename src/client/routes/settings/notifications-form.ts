import { extractErrorMessage } from "@/lib/error-message";
import type { NotificationChannelPatch, NotificationChannelSettings } from "@shared/settings";

/** What a kind is called on its rows; a kind this build lacks by its id. */
const KIND_LABEL: Record<string, string> = { telegram: "Telegram" };

/** A kind this build can send to and edit. One it lacks (a newer build's,
 *  or a hand edit) is kept as the file has it: shown, removable, not saved. */
export function isKnownKind(kind: string): boolean {
  return Object.hasOwn(KIND_LABEL, kind);
}

/** "Telegram · @mandate_bot": the kind, and who it sends as. */
export function channelDescription(channel: Pick<NotificationChannelSettings, "kind" | "values">): string {
  const label = KIND_LABEL[channel.kind] ?? channel.kind;
  const who = channel.values.botName;
  return who ? `${label} · ${who}` : label;
}

/** A saved channel as a save sends it, its secrets left out (kept as saved). */
export function channelPatch(channel: NotificationChannelSettings, change: Partial<Pick<NotificationChannelPatch, "enabled">> = {}): NotificationChannelPatch {
  return { id: channel.id, kind: channel.kind, name: channel.name, enabled: channel.enabled, includeText: channel.includeText, values: { ...channel.values }, ...change };
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function sentText(sentAt: string): string {
  return `Sent at ${clockTime(sentAt)}. Check your phone.`;
}

export function failedText(error: unknown): string {
  const message = (extractErrorMessage(error instanceof Error ? error.message : error) || "it did not answer").replace(/[.\s]+$/, "");
  return `Failed: ${message}.`;
}
