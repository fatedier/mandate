import type { Config, NotificationChannelConfig } from "../../config.js";
import type { HttpClient } from "../../platform/http/http-client.js";

/** One notice as a channel sends it. `text` is "" when the channel takes the
 *  title alone; `url` null when Mandate has no address other devices open. */
export interface OutgoingNotification {
  key: string;
  level: "needs_you" | "news";
  title: string;
  text: string;
  url: string | null;
}

/** `ref`: the channel's own id for what it showed, for replacing or
 *  withdrawing it later; null when it has none. */
export type SendOutcome = { ok: true; ref: string | null } | { ok: false; error: string };

export interface ChannelContext {
  http: HttpClient;
  config: Config["notifications"];
}

/**
 * A kind of place notices go. Each kind sends; one that can change or take
 * back what it showed has `replace` / `withdraw`, which act by the ref its
 * send returned — having them is what it can do. Everything a kind needs is
 * in the channel's values; `secretKeys` are written from Settings and never
 * read back.
 */
export interface ChannelKind {
  id: string;
  label: string;
  secretKeys: readonly string[];
  /** It has what sending needs. */
  ready(channel: NotificationChannelConfig): boolean;
  send(ctx: ChannelContext, channel: NotificationChannelConfig, notice: OutgoingNotification): Promise<SendOutcome>;
  replace?(ctx: ChannelContext, channel: NotificationChannelConfig, ref: string, notice: OutgoingNotification): Promise<SendOutcome>;
  withdraw?(ctx: ChannelContext, channel: NotificationChannelConfig, ref: string): Promise<SendOutcome>;
}
