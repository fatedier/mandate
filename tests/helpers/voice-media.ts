import { act } from "react";
import { useVoiceStore } from "@/store/voice";

interface FakeVoiceSocket {
  url: string;
  readyState: number;
  closed: boolean;
  sent: string[];
  onopen: (() => void) | null;
  onmessage: unknown;
  onerror: unknown;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

/** A mic, an audio context and sockets that record what the voice hook
 *  asked of them. With `grant: "manual"`, each mic request waits for its
 *  grant. `deliver` plays the server: it hands a socket one message. */
export function fakeVoiceMedia(grant: "now" | "manual" = "now") {
  const sockets: FakeVoiceSocket[] = [];
  /** Sources scheduled for playback; `end()` plays one to its end. */
  const sources: Array<{ onended: (() => void) | null; end(): void }> = [];
  /** The next mic requests fail with these errors, in order. */
  const micFailures: Error[] = [];
  const grants: Array<() => void> = [];
  const stopped: string[] = [];
  class FakeSocket implements FakeVoiceSocket {
    static OPEN = 1;
    readyState = 0;
    closed = false;
    sent: string[] = [];
    onopen: (() => void) | null = null; onmessage: unknown = null; onerror: unknown = null; onclose: (() => void) | null = null;
    constructor(public url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  const node = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
  /** Enough of a mic graph for `ready` to start capture, and of playback
   *  for the agent's audio. */
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { return node(); }
    createBuffer(_channels: number, length: number, rate: number) {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    }
    createBufferSource() {
      const source = {
        buffer: null as unknown, onended: null as (() => void) | null,
        connect() {}, start() {}, stop() {},
        end() { source.onended?.(); }
      };
      sources.push(source);
      return source;
    }
    close() { return Promise.resolve(); }
  }
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { WebSocket: g.WebSocket, AudioContext: g.AudioContext, mediaDevices: navigator.mediaDevices };
  g.WebSocket = FakeSocket;
  g.AudioContext = FakeAudioContext;
  let n = 0;
  const getUserMedia = () => {
    const failure = micFailures.shift();
    if (failure) return Promise.reject(failure);
    const id = `mic${n++}`;
    const stream = { getTracks: () => [{ stop: () => stopped.push(id) }] };
    return grant === "now" ? Promise.resolve(stream) : new Promise((resolve) => grants.push(() => resolve(stream)));
  };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  const deliver = (socket: FakeVoiceSocket, msg: unknown) => act(() => {
    (socket.onmessage as ((e: { data: string }) => void) | null)?.({ data: JSON.stringify(msg) });
  });
  const restore = () => {
    act(() => useVoiceStore.getState().stopVoice());
    g.WebSocket = saved.WebSocket;
    g.AudioContext = saved.AudioContext;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: saved.mediaDevices });
  };
  return { sockets, grants, stopped, sources, micFailures, deliver, restore };
}
