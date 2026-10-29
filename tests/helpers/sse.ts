/**
 * Server-sent events for tests: readSse reads a response's stream frame by
 * frame, sseFrame writes one for a stub server.
 */
export interface SseFrame {
  /** The frame's `event:`, "message" when it has none (the SSE default). */
  event: string;
  /** Its `data:` lines joined and parsed as JSON (readSse refuses data that
   *  is not), or the text itself when read with `{ json: false }`. */
  data: unknown;
  /** The same data, unparsed. */
  text: string;
  /** The frame's size on the wire, separator included. */
  bytes: number;
}

/** Reads frames off a stream. Data must be JSON, as every stream this app
 *  writes is: a frame that is not throws, naming its event, so a broken
 *  serializer fails the test as it would break the client. `{ json: false }`
 *  reads a stream whose data is plain text. */
export function readSse(source: Response | ReadableStream<Uint8Array>, { json = true }: { json?: boolean } = {}) {
  const reader = (source instanceof Response ? source.body! : source).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** The first frame in `text` as its lines, and where it ends, or null
   *  while the blank line that ends it has not arrived. A line ends at CRLF,
   *  LF or CR (the spec's three); a CR at the very end may be half of a CRLF
   *  still in flight, so it waits for more unless the stream is done. */
  const take = (text: string, done: boolean): { lines: string[]; end: number } | null => {
    const lines: string[] = [];
    let pos = 0;
    for (;;) {
      let i = pos;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      if (i >= text.length) return null;
      let next = i + 1;
      if (text[i] === "\r") {
        if (next >= text.length && !done) return null;
        if (text[next] === "\n") next++;
      }
      const line = text.slice(pos, i);
      pos = next;
      if (line === "") return { lines, end: pos };
      lines.push(line);
    }
  };

  const parse = (lines: string[], wire: string): SseFrame | null => {
    let event = "";
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    // A comment-only frame (a keep-alive) carries nothing to read.
    if (event === "" && data.length === 0) return null;
    const text = data.join("\n");
    const name = event || "message";
    let parsed: unknown = text;
    if (json) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`readSse: ${name}'s data is not JSON: ${text.slice(0, 120)}`);
      }
    }
    return { event: name, data: parsed, text, bytes: new TextEncoder().encode(wire).length };
  };

  /** The next frame; throws if the stream ends first. */
  const next = async (): Promise<SseFrame> => {
    let done = false;
    for (;;) {
      const found = take(buffer, done);
      if (found) {
        const frame = parse(found.lines, buffer.slice(0, found.end));
        buffer = buffer.slice(found.end);
        if (frame) return frame;
        continue;
      }
      if (done) throw new Error("the event stream ended before the next event");
      const chunk = await reader.read();
      if (chunk.done) done = true;
      else buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  /** Reads until a frame matches; returns it and the events seen, in order,
   *  up to and including it. */
  const until = async (match: (frame: SseFrame) => boolean): Promise<{ found: SseFrame; seen: string[] }> => {
    const seen: string[] = [];
    for (;;) {
      const frame = await next();
      seen.push(frame.event);
      if (match(frame)) return { found: frame, seen };
    }
  };

  return { next, until, close: () => reader.cancel().catch(() => {}) };
}

/** One frame as a server writes it: `event:` when given, and the data as
 *  JSON. */
export function sseFrame({ event, data }: { event?: string; data: unknown }): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}
