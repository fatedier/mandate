/**
 * A stand-in for the model-call worker, for the host's failure paths. Its
 * behaviour comes from FAKE_MODEL_WORKER_MODE in the env it is started with:
 *  - "never-ready": loads and says nothing;
 *  - "silent": says ready, then nothing (a stuck worker: no alive);
 *  - "late": says ready and alive once, then for every stream sends a delta
 *    every 30 ms and never ends it, and stops saying alive.
 */
declare const self: Worker;

export {};

const mode = process.env.FAKE_MODEL_WORKER_MODE ?? "silent";

self.onmessage = (event: MessageEvent<{ type: string; streamId?: string }>) => {
  if (mode !== "late" || event.data.type !== "stream") return;
  const streamId = event.data.streamId;
  setInterval(() => self.postMessage({ type: "delta", streamId, text: "x" }), 30);
};

if (mode !== "never-ready") self.postMessage({ type: "ready" });
if (mode === "late") self.postMessage({ type: "alive" });
