import type { WSContext } from "hono/ws";
import {
  API_ROUTES,
  VOICE_CLIENT_MESSAGES,
  VOICE_SERVER_MESSAGES,
  type VoiceClientMessage,
  type VoiceServerMessage
} from "../../../shared/api-contracts.js";
import { parseUiLocation } from "../ui-context/ui-context-registry.js";
import type { OrchestratorEvents, VoiceSessionOrchestrator } from "./voice-session-orchestrator.js";

export const VOICE_PATH = API_ROUTES.voiceWs;

export interface VoiceRouteDeps {
  /** Build a fresh orchestrator per session. */
  buildOrchestrator: () => VoiceSessionOrchestrator;
}

interface ActiveSession {
  ws: WSContext;
  orch: VoiceSessionOrchestrator;
}

export class VoiceSessionGateway {
  private active: ActiveSession | null = null;

  constructor(private readonly deps: VoiceRouteDeps) {}

  /** Creates Hono websocket lifecycle handlers for one client connection. */
  createHandlers() {
    let orch: VoiceSessionOrchestrator | null = null;

    return {
      onOpen: async (_event: unknown, ws: WSContext) => {
        orch = await this.open(ws);
      },
      onMessage: async (event: { data: unknown }) => {
        if (!orch) return;
        this.handleMessage(orch, event.data);
      },
      onClose: async () => {
        if (orch) {
          try { await orch.close("client-closed"); } catch { /* ignore */ }
          this.clearActive(orch);
          orch = null;
        }
      },
      onError: async () => {
        if (orch) {
          try { await orch.close("ws-error"); } catch { /* ignore */ }
          this.clearActive(orch);
          orch = null;
        }
      }
    };
  }

  private async open(ws: WSContext): Promise<VoiceSessionOrchestrator | null> {
    await this.supersedeActive();

    const orch = this.deps.buildOrchestrator();
    this.bindOrchestratorEvents(orch, ws);

    try {
      await orch.start();
      this.active = { ws, orch };
      sendJson(ws, { type: VOICE_SERVER_MESSAGES.ready });
      return orch;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(ws, { type: VOICE_SERVER_MESSAGES.error, message });
      closeWs(ws, 1011, message);
      return null;
    }
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
      onClose: (reason) => {
        sendJson(ws, { type: VOICE_SERVER_MESSAGES.closed, reason });
        closeWs(ws, 1000, reason);
        this.clearActive(orch);
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
    } else if (msg.type === VOICE_CLIENT_MESSAGES.uiLocation) {
      const location = parseUiLocation(msg.uiLocation);
      if (location) orch.setUiLocation(location);
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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
