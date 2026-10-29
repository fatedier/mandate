import { useCallback, useEffect, useRef } from "react";
import { useVoiceStore } from "@/store/voice";
import { api } from "@/lib/api-paths";
import { arrayBufferToBase64, base64ToArrayBuffer } from "@shared/base64";
import {
  VOICE_CLIENT_MESSAGES,
  VOICE_SERVER_MESSAGES,
  type VoiceClientAudioMessage,
  type VoiceServerMessage
} from "@shared/api-contracts";

const TARGET_SAMPLE_RATE = 24000;
/** Waits before reopening a socket that dropped by itself:
 *  1, 2, 5 and 10 seconds, then every 30 while voice stays on. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const RECONNECT_EVERY_MS = 30000;
const FRAME_DURATION_MS = 100;
const FRAME_SAMPLES = (TARGET_SAMPLE_RATE * FRAME_DURATION_MS) / 1000;

interface SessionRefs {
  /** Bumped by every teardown: a connect that started before it is stale. */
  generation: number;
  ws: WebSocket | null;
  audioCtx: AudioContext | null;
  mediaStream: MediaStream | null;
  micSource: MediaStreamAudioSourceNode | null;
  micProcessor: ScriptProcessorNode | AudioWorkletNode | null;
  playbackQueue: AudioBuffer[];
  playbackTime: number;
  pcmBuffer: Float32Array | null;
  /** Active AudioBufferSourceNodes scheduled for playback. Tracked so a
   *  speech-started event from the server can hard-stop them all. */
  scheduledSources: AudioBufferSourceNode[];
  /** Retries since the last `ready`: picks the next wait. */
  reconnectStep: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Between a drop and the next `ready`: openings say "Reconnecting…". */
  reconnecting: boolean;
}

/** "Voice stopped after 5 minutes without talking." and its siblings. */
function stopNoticeFor(reason: string, afterMs: number | undefined, message?: string): string | undefined {
  const minutes = afterMs ? Math.max(1, Math.round(afterMs / 60_000)) : null;
  const span = minutes ? `${minutes} minute${minutes === 1 ? "" : "s"}` : null;
  if (reason === "idle-timeout") return span ? `Voice stopped after ${span} without talking.` : "Voice stopped: nobody spoke for a while.";
  if (reason === "max-session-reached") return span ? `Voice stopped after ${span}.` : "Voice stopped: it reached its length limit.";
  if (reason === "provider-unavailable") return message ? `Voice stopped: ${message}` : "Voice stopped: the voice service did not come back.";
  return undefined;
}

export function useVoiceSession() {
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const sessionKey = useVoiceStore((s) => s.sessionKey);
  const stopVoice = useVoiceStore((s) => s.stopVoice);
  const setConnectionState = useVoiceStore((s) => s.setConnectionState);
  const setError = useVoiceStore((s) => s.setError);
  const appendInProgressDelta = useVoiceStore((s) => s.appendInProgressDelta);
  const clearInProgress = useVoiceStore((s) => s.clearInProgress);
  const setMicLevel = useVoiceStore((s) => s.setMicLevel);
  const setModelSpeaking = useVoiceStore((s) => s.setModelSpeaking);

  const refs = useRef<SessionRefs>({
    generation: 0,
    ws: null, audioCtx: null, mediaStream: null,
    micSource: null, micProcessor: null,
    playbackQueue: [], playbackTime: 0, pcmBuffer: null,
    scheduledSources: [],
    reconnectStep: 0,
    reconnectTimer: null,
    reconnecting: false
  });

  /** The latest `connect`, for the reconnect timer `connect` itself sets. */
  const connectRef = useRef<() => Promise<void>>(async () => {});

  const teardown = useCallback(() => {
    const r = refs.current;
    r.generation += 1;
    if (r.reconnectTimer) {
      clearTimeout(r.reconnectTimer);
      r.reconnectTimer = null;
    }
    if (r.ws) {
      try { r.ws.close(1000, "client teardown"); } catch { /* ignore */ }
      r.ws = null;
    }
    if (r.micProcessor) {
      try { (r.micProcessor as { disconnect?: () => void }).disconnect?.(); } catch { /* ignore */ }
      r.micProcessor = null;
    }
    if (r.micSource) {
      try { r.micSource.disconnect(); } catch { /* ignore */ }
      r.micSource = null;
    }
    if (r.mediaStream) {
      for (const t of r.mediaStream.getTracks()) t.stop();
      r.mediaStream = null;
    }
    if (r.audioCtx) {
      try { void r.audioCtx.close(); } catch { /* ignore */ }
      r.audioCtx = null;
    }
    r.playbackQueue = [];
    r.playbackTime = 0;
    r.pcmBuffer = null;
    r.scheduledSources = [];
    clearInProgress("user");
    clearInProgress("assistant");
  }, [clearInProgress]);

  /** Another try after the next wait: 1, 2, 5, 10 s, then every 30. */
  const scheduleReconnect = useCallback(() => {
    const r = refs.current;
    r.reconnecting = true;
    setConnectionState("reconnecting");
    const delay = RECONNECT_DELAYS_MS[r.reconnectStep] ?? RECONNECT_EVERY_MS;
    r.reconnectStep += 1;
    r.reconnectTimer = setTimeout(() => {
      r.reconnectTimer = null;
      void connectRef.current();
    }, delay);
  }, [setConnectionState]);

  const connect = useCallback(async () => {
    const generation = refs.current.generation;
    // A retry after a drop keeps saying so until the server is ready.
    const opening = (state: "requesting-mic" | "connecting") =>
      setConnectionState(refs.current.reconnecting ? "reconnecting" : state);
    opening("requesting-mic");
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (generation !== refs.current.generation) return;
      const refused = err instanceof Error && err.name === "NotAllowedError";
      // Mid-reconnect, a mic busy for a moment is asked for again; one
      // refused for good stops the tries.
      if (refs.current.reconnecting && !refused) {
        scheduleReconnect();
        return;
      }
      setError(refused ? "Microphone permission denied. Allow access and retry." : "The microphone could not be opened.");
      setConnectionState("error");
      return;
    }
    // Torn down while the mic was being granted (voice stopped, or started
    // again): this session is over before it opened.
    if (generation !== refs.current.generation) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    refs.current.mediaStream = stream;

    opening("connecting");
    const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    refs.current.audioCtx = audioCtx;
    refs.current.playbackTime = audioCtx.currentTime;

    // Every session is the global agent's: the socket names no thread.
    const ws = new WebSocket(api.voiceWs(useVoiceStore.getState().activationId));
    refs.current.ws = ws;

    // A socket that was torn down (voice stopped or restarted) can still
    // fire: it must not touch the session that replaced it.
    const current = () => refs.current.ws === ws;
    ws.onmessage = (event) => {
      if (!current()) return;
      let msg: unknown;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleServerMessage(msg as VoiceServerMessage);
    };
    // A socket error is followed by its close, which decides what happens.
    ws.onerror = () => {};
    ws.onclose = () => {
      // Ours (stopped, restarted, moved) or after the server stopped voice
      // (closed, which turned voice mode off): nothing to do.
      if (!current() || !useVoiceStore.getState().voiceMode) return;
      // It dropped by itself: let this session go and open a new one.
      teardown();
      scheduleReconnect();
    };

    function handleServerMessage(msg: VoiceServerMessage) {
      switch (msg.type) {
        case VOICE_SERVER_MESSAGES.ready:
          refs.current.reconnecting = false;
          refs.current.reconnectStep = 0;
          setConnectionState("listening");
          startMicCapture();
          break;
        // The server reopening its provider: the socket stays.
        case VOICE_SERVER_MESSAGES.reconnecting:
          setConnectionState("reconnecting");
          break;
        case VOICE_SERVER_MESSAGES.resumed:
          // Words from before the drop may still be playing.
          setConnectionState(refs.current.scheduledSources.length > 0 ? "speaking" : "listening");
          break;
        case VOICE_SERVER_MESSAGES.audio:
          enqueuePlayback(msg.pcm);
          setModelSpeaking(true);
          break;
        case VOICE_SERVER_MESSAGES.speechStarted: {
          // Server VAD detected the user starting to speak. Hard-cut any
          // queued/playing model audio so the user isn't talked over.
          for (const src of refs.current.scheduledSources) {
            try { src.stop(); } catch { /* already stopped */ }
          }
          refs.current.scheduledSources = [];
          const ctx = refs.current.audioCtx;
          refs.current.playbackTime = ctx?.currentTime ?? 0;
          setModelSpeaking(false);
          break;
        }
        case VOICE_SERVER_MESSAGES.transcript: {
          const speaker = msg.speaker;
          const text = msg.text ?? "";
          const isFinal = msg.isFinal;
          if (isFinal) {
            // Persisted message arrives via agentMessageAppended SSE shortly.
            // Just clear the ephemeral slot.
            clearInProgress(speaker);
          } else {
            appendInProgressDelta(speaker, text);
          }
          break;
        }
        case VOICE_SERVER_MESSAGES.error:
          setError(msg.message ?? "Voice service error");
          setConnectionState("error");
          break;
        case VOICE_SERVER_MESSAGES.superseded:
          // Another device took voice: this one waits for Resume here (the
          // teardown makes this socket's close nobody's).
          teardown();
          setConnectionState("moved");
          break;
        case VOICE_SERVER_MESSAGES.closed:
          // A limit, or the service gone for good: voice stops, with why.
          stopVoice(stopNoticeFor(msg.reason, msg.afterMs, msg.message));
          break;
      }
    }

    function startMicCapture() {
      const ctx = refs.current.audioCtx;
      const src = ctx?.createMediaStreamSource(stream);
      if (!ctx || !src) return;
      refs.current.micSource = src;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      refs.current.micProcessor = processor;
      let pcmBuffer = new Float32Array(0);
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        if (useVoiceStore.getState().micMuted) {
          pcmBuffer = new Float32Array(0);
          setMicLevel(0);
          return;
        }

        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          const v = input[i] ?? 0;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / input.length);
        setMicLevel(Math.min(1, rms * 4));

        const merged = new Float32Array(pcmBuffer.length + input.length);
        merged.set(pcmBuffer);
        merged.set(input, pcmBuffer.length);
        pcmBuffer = merged;

        while (pcmBuffer.length >= FRAME_SAMPLES) {
          const chunk = pcmBuffer.subarray(0, FRAME_SAMPLES);
          pcmBuffer = pcmBuffer.subarray(FRAME_SAMPLES).slice();

          const pcm16 = floatToPcm16(chunk);
          const b64 = arrayBufferToBase64(pcm16.buffer as ArrayBuffer);
          if (ws.readyState === WebSocket.OPEN) {
            const message = {
              type: VOICE_CLIENT_MESSAGES.audio,
              pcm: b64,
              sampleRate: TARGET_SAMPLE_RATE
            } satisfies VoiceClientAudioMessage;
            ws.send(JSON.stringify(message));
          }
        }
      };
      src.connect(processor);
      processor.connect(ctx.destination);
    }

    function enqueuePlayback(b64: string): void {
      const ctx = refs.current.audioCtx;
      if (!ctx) return;
      const buf = base64ToArrayBuffer(b64);
      const pcm16 = new Int16Array(buf);
      const float = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float[i] = (pcm16[i] ?? 0) / 0x8000;
      const audioBuf = ctx.createBuffer(1, float.length, TARGET_SAMPLE_RATE);
      audioBuf.getChannelData(0).set(float);
      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(ctx.destination);
      const now = ctx.currentTime;
      const startAt = Math.max(now, refs.current.playbackTime);
      source.start(startAt);
      refs.current.playbackTime = startAt + audioBuf.duration;
      refs.current.scheduledSources.push(source);
      source.onended = () => {
        refs.current.scheduledSources = refs.current.scheduledSources.filter(
          (s) => s !== source
        );
        // The last scheduled sound ended: the agent has stopped speaking.
        if (refs.current.scheduledSources.length === 0) setModelSpeaking(false);
      };
    }
  }, [setConnectionState, setError, appendInProgressDelta, clearInProgress, setMicLevel, setModelSpeaking, stopVoice, teardown, scheduleReconnect]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  useEffect(() => {
    if (!voiceMode) {
      teardown();
      return;
    }
    // A start or Resume here (a new sessionKey) opens a fresh session.
    refs.current.reconnecting = false;
    refs.current.reconnectStep = 0;
    void connect();
    return () => { teardown(); };
  }, [voiceMode, sessionKey, connect, teardown]);

  return {};
}

function floatToPcm16(float: Float32Array): Int16Array {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
