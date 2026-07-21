import { useCallback, useEffect, useRef } from "react";
import { useVoiceStore } from "@/store/voice";
import { api } from "@/lib/api-paths";
import { getClientId, getCurrentUiLocation, subscribeUiLocation } from "@/lib/ui-context";
import {
  VOICE_CLIENT_MESSAGES,
  VOICE_SERVER_MESSAGES,
  type VoiceClientAudioMessage,
  type VoiceClientUiLocationMessage,
  type VoiceServerMessage
} from "@shared/api-contracts";

const TARGET_SAMPLE_RATE = 24000;
const FRAME_DURATION_MS = 100;
const FRAME_SAMPLES = (TARGET_SAMPLE_RATE * FRAME_DURATION_MS) / 1000;

interface SessionRefs {
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
  uiLocationUnsub: (() => void) | null;
}

export function useVoiceSession() {
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const setConnectionState = useVoiceStore((s) => s.setConnectionState);
  const setError = useVoiceStore((s) => s.setError);
  const appendInProgressDelta = useVoiceStore((s) => s.appendInProgressDelta);
  const clearInProgress = useVoiceStore((s) => s.clearInProgress);
  const setMicLevel = useVoiceStore((s) => s.setMicLevel);
  const setModelSpeaking = useVoiceStore((s) => s.setModelSpeaking);

  const refs = useRef<SessionRefs>({
    ws: null, audioCtx: null, mediaStream: null,
    micSource: null, micProcessor: null,
    playbackQueue: [], playbackTime: 0, pcmBuffer: null,
    scheduledSources: [],
    uiLocationUnsub: null
  });

  const teardown = useCallback(() => {
    const r = refs.current;
    if (r.ws) {
      try { r.ws.close(1000, "client teardown"); } catch { /* ignore */ }
      r.ws = null;
    }
    r.uiLocationUnsub?.();
    r.uiLocationUnsub = null;
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

  const connect = useCallback(async () => {
    setConnectionState("requesting-mic");
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone permission denied. Allow access and retry.");
      setConnectionState("error");
      return;
    }
    refs.current.mediaStream = stream;

    setConnectionState("connecting");
    const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    refs.current.audioCtx = audioCtx;
    refs.current.playbackTime = audioCtx.currentTime;

    const ws = new WebSocket(api.voiceWs());
    refs.current.ws = ws;

    const sendUiLocation = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const message = {
        type: VOICE_CLIENT_MESSAGES.uiLocation,
        clientId: getClientId(),
        uiLocation: getCurrentUiLocation()
      } satisfies VoiceClientUiLocationMessage;
      ws.send(JSON.stringify(message));
    };
    refs.current.uiLocationUnsub = subscribeUiLocation(sendUiLocation);
    ws.onopen = () => { sendUiLocation(); };
    ws.onmessage = (event) => {
      let msg: unknown;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleServerMessage(msg as VoiceServerMessage);
    };
    ws.onerror = () => {
      setError("Voice connection error.");
      setConnectionState("error");
    };
    ws.onclose = () => {
      if (refs.current.ws) setConnectionState("closed");
      // Don't auto-clear voiceMode here — the close might be from setVoiceMode(false)
      // already (via teardown). If it was a server-initiated close, the next render
      // sees voiceMode=true with connectionState="closed", which the bar can show.
    };

    function handleServerMessage(msg: VoiceServerMessage) {
      switch (msg.type) {
        case VOICE_SERVER_MESSAGES.ready:
          setConnectionState("listening");
          startMicCapture();
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
          setError("Another voice session took over this connection.");
          setConnectionState("closed");
          break;
        case VOICE_SERVER_MESSAGES.closed:
          if (msg.reason === "idle-timeout") setError("Session idle, restart to continue.");
          else if (msg.reason === "max-session-reached") setError("Max session length reached.");
          setConnectionState("closed");
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
        if (Math.abs(refs.current.playbackTime - (ctx.currentTime + audioBuf.duration)) < 0.05) {
          setModelSpeaking(false);
        }
      };
    }
  }, [setConnectionState, setError, appendInProgressDelta, clearInProgress, setMicLevel, setModelSpeaking]);

  useEffect(() => {
    if (!voiceMode) {
      teardown();
      return;
    }
    void connect();
    return () => { teardown(); };
  }, [voiceMode, connect, teardown]);

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
