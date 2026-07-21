import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { VOICE_PATH, VoiceSessionGateway, type VoiceRouteDeps } from "./voice-gateway.js";

/** Mounts GET /api/voice/ws as a WebSocket upgrade. Single-tenant: a new
 *  connection takes over and the prior connection receives a `superseded`
 *  event before being closed. */
export function mountVoiceRoute(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  deps: VoiceRouteDeps
): void {
  const gateway = new VoiceSessionGateway(deps);
  app.get(VOICE_PATH, upgradeWebSocket(() => gateway.createHandlers()));
}
