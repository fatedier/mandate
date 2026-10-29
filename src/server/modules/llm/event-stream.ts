import { EventSourceParserStream } from "eventsource-parser/stream";

/**
 * A server-sent event stream with each event's data passed through `map`, its
 * event name and id kept; any other response as it came, an error response
 * too (a gateway may label its JSON error a stream: read as one, its words
 * were lost). For a provider stream a package reads too strictly.
 */
export function mapEventStreamData(response: Response, map: (data: string) => string): Response {
  if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
  const encoder = new TextEncoder();
  const body = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .pipeThrough(new TransformStream<{ event?: string; id?: string; data: string }, Uint8Array>({
      transform(event, controller) {
        const lines = [
          ...(event.event ? [`event: ${event.event}`] : []),
          ...(event.id ? [`id: ${event.id}`] : []),
          ...map(event.data).split("\n").map((line) => `data: ${line}`)
        ];
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
      }
    }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
