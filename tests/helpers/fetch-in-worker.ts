/** A worker that fetches each URL it is sent and answers with the outcome. */
declare const self: Worker;

export {};

self.onmessage = async (event: MessageEvent<{ url: string }>) => {
  try {
    const response = await fetch(event.data.url);
    self.postMessage({ ok: true, status: response.status });
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
self.postMessage({ ready: true });
