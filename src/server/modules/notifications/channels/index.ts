import type { ChannelKind } from "../channel-kind.js";
import { telegramKind } from "./telegram.js";

/** Every kind of channel this build can send to. */
export const CHANNEL_KINDS: readonly ChannelKind[] = [telegramKind];
