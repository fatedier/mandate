import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { VOICE_PATH, VoiceSessionGateway, type VoiceRouteDeps } from "./voice-gateway.js";

/** Mounts GET /api/voice/ws as a WebSocket upgrade. Every session is the
 *  global agent's, in its one thread. Single-tenant: a new connection takes
 *  over and the prior connection receives a `superseded` event before being
 *  closed. */
export function mountVoiceRoute(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  deps: VoiceRouteDeps
): void {
  const gateway = new VoiceSessionGateway(deps);
  // ?activation= names the voice turn-on: a reconnect with the same one
  // continues it (its limits' clocks, what came back meanwhile).
  app.get(VOICE_PATH, upgradeWebSocket((c) => gateway.createHandlers({ activationId: c.req.query("activation") ?? null })));
}
