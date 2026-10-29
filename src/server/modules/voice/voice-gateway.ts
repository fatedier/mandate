import type { WSContext } from "hono/ws";
import {
  API_ROUTES,
  VOICE_CLIENT_MESSAGES,
  VOICE_SERVER_MESSAGES,
  type VoiceClientMessage,
  type VoiceServerMessage
} from "../../../shared/api-contracts.js";
import type { OrchestratorEvents, VoiceSessionOrchestrator } from "./voice-session-orchestrator.js";
import { isRecord } from "../../../shared/guards.js";
import { errorText } from "../../../shared/error-text.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../../../shared/base64.js";

export const VOICE_PATH = API_ROUTES.voiceWs;

/** One voice activation's clocks: a session that continues one the page
 *  lost (its socket dropped and reconnected) keeps them. */
export interface VoiceSessionClocks {
  /** When voice was turned on: the length limit counts from here. */
  startedAtMs: number;
  /** When the user last spoke: idle counts from here. */
  lastSpeechAtMs: number;
  /** Handoff outcomes this activation's sessions said: not said again. */
  heardUpdates: ReadonlySet<string>;
}

export interface VoiceRouteDeps {
  /** Build a fresh orchestrator per session: the global agent's. */
  buildOrchestrator: (clocks: VoiceSessionClocks) => VoiceSessionOrchestrator;
}

/** Ends that stop voice for good (the page turns it off): the next start is
 *  a new activation, whatever id it brings. */
const ENDS_ACTIVATION = new Set(["idle-timeout", "max-session-reached", "provider-unavailable"]);

interface Activation {
  id: string;
  startedAtMs: number;
  lastSpeechAtMs: number;
  heard: Set<string>;
}

interface ActiveSession {
  ws: WSContext;
  orch: VoiceSessionOrchestrator;
}

export class VoiceSessionGateway {
  private active: ActiveSession | null = null;
  /** The voice turn-on the last session belonged to (single-tenant). */
  private activation: Activation | null = null;

  constructor(private readonly deps: VoiceRouteDeps) {}

  /** Creates Hono websocket lifecycle handlers for one client connection.
   *  `activationId` names the voice turn-on the page is in: the same id
   *  after a reconnect continues it. */
  createHandlers(options: { activationId?: string | null } = {}) {
    let orch: VoiceSessionOrchestrator | null = null;
    // Why the connection went away while its session was still starting:
    // that session is closed as soon as it is up, and nothing is applied.
    let goneReason: string | null = null;

    return {
      onOpen: async (_event: unknown, ws: WSContext) => {
        const opened = await this.open(ws, options.activationId ?? null);
        if (goneReason) {
          if (opened) {
            try { await opened.close(goneReason); } catch { /* ignore */ }
            this.clearActive(opened);
          }
          return;
        }
        orch = opened;
      },
      onMessage: async (event: { data: unknown }) => {
        if (!orch) return;
        this.handleMessage(orch, event.data);
      },
      onClose: async () => {
        goneReason ??= "client-closed";
        if (orch) {
          try { await orch.close("client-closed"); } catch { /* ignore */ }
          this.clearActive(orch);
          orch = null;
        }
      },
      onError: async () => {
        goneReason ??= "ws-error";
        if (orch) {
          try { await orch.close("ws-error"); } catch { /* ignore */ }
          this.clearActive(orch);
          orch = null;
        }
      }
    };
  }

  private async open(ws: WSContext, activationId: string | null): Promise<VoiceSessionOrchestrator | null> {
    await this.supersedeActive();

    const now = Date.now();
    const continuing = activationId && this.activation?.id === activationId ? this.activation : null;
    const activation: Activation = continuing ?? { id: activationId ?? "", startedAtMs: now, lastSpeechAtMs: now, heard: new Set() };
    this.activation = activationId ? activation : null;
    const orch = this.deps.buildOrchestrator({
      startedAtMs: activation.startedAtMs,
      lastSpeechAtMs: activation.lastSpeechAtMs,
      heardUpdates: activation.heard
    });
    orch.on("onUserSpeech", (at) => { activation.lastSpeechAtMs = at; });
    orch.on("onUpdatesHeard", (keys) => { for (const key of keys) activation.heard.add(key); });
    orch.on("onClose", (reason) => {
      if (ENDS_ACTIVATION.has(reason)) this.end(activation);
    });
    this.bindOrchestratorEvents(orch, ws);

    try {
      await orch.start();
      this.active = { ws, orch };
      sendJson(ws, { type: VOICE_SERVER_MESSAGES.ready });
      return orch;
    } catch (err) {
      // The voice service would not open: voice stops, saying why, and the
      // next start is a new activation (as when it would not come back).
      const message = errorText(err);
      this.end(activation);
      sendJson(ws, { type: VOICE_SERVER_MESSAGES.closed, reason: "provider-unavailable", message });
      closeWs(ws, 1000, "provider-unavailable");
      return null;
    }
  }

  /** Voice stopped for good: the next start is a new activation. */
  private end(activation: Activation): void {
    if (this.activation === activation) this.activation = null;
  }

  private async supersedeActive(): Promise<void> {
    if (!this.active) return;

    const previous = this.active;
    sendJson(previous.ws, { type: VOICE_SERVER_MESSAGES.superseded });
    closeWs(previous.ws, 1000, "superseded");
    this.active = null;

    try { await previous.orch.close("superseded"); } catch { /* ignore */ }
  }

  private bindOrchestratorEvents(orch: VoiceSessionOrchestrator, ws: WSContext): void {
    const handlers: Partial<OrchestratorEvents> = {
      onAudio: (frame) => {
        sendJson(ws, {
          type: VOICE_SERVER_MESSAGES.audio,
          pcm: arrayBufferToBase64(frame.pcm),
          sampleRate: frame.sampleRate,
          channels: frame.channels
        });
      },
      onTranscript: (delta) => {
        sendJson(ws, { type: VOICE_SERVER_MESSAGES.transcript, ...delta });
      },
      onSpeechStarted: () => {
        sendJson(ws, { type: VOICE_SERVER_MESSAGES.speechStarted });
      },
      onError: (message) => {
        sendJson(ws, { type: VOICE_SERVER_MESSAGES.error, message });
      },
      onClose: (reason, afterMs) => {
        sendJson(ws, { type: VOICE_SERVER_MESSAGES.closed, reason, ...(afterMs !== undefined ? { afterMs } : {}) });
        closeWs(ws, 1000, reason);
        this.clearActive(orch);
      },
      onReconnecting: () => {
        sendJson(ws, { type: VOICE_SERVER_MESSAGES.reconnecting });
      },
      onResumed: () => {
        sendJson(ws, { type: VOICE_SERVER_MESSAGES.resumed });
      }
    };

    for (const [event, handler] of Object.entries(handlers) as Array<[
      keyof OrchestratorEvents,
      OrchestratorEvents[keyof OrchestratorEvents]
    ]>) {
      orch.on(event, handler);
    }
  }

  private handleMessage(orch: VoiceSessionOrchestrator, data: unknown): void {
    const msg = parseJsonMessage(data) as Partial<VoiceClientMessage> | null;
    if (!isRecord(msg)) return;

    if (msg.type === VOICE_CLIENT_MESSAGES.audio && typeof msg.pcm === "string") {
      orch.sendAudio({
        pcm: base64ToArrayBuffer(msg.pcm),
        sampleRate: typeof msg.sampleRate === "number" ? msg.sampleRate : 24000,
        channels: 1
      });
    } else if (msg.type === VOICE_CLIENT_MESSAGES.cancel) {
      orch.cancelResponse();
    }
  }

  private clearActive(orch: VoiceSessionOrchestrator): void {
    if (this.active?.orch === orch) {
      this.active = null;
    }
  }
}

function parseJsonMessage(data: unknown): unknown {
  try {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(data).toString("utf8"));
    }
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
    }
  } catch {
    return null;
  }
  return null;
}

function sendJson(ws: WSContext, payload: VoiceServerMessage): void {
  try { ws.send(JSON.stringify(payload)); } catch { /* ws gone */ }
}

function closeWs(ws: WSContext, code: number, reason: string): void {
  try { ws.close(code, reason); } catch { /* ws gone */ }
}
