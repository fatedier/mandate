import * as fs from "node:fs";
import * as path from "node:path";
import { sseFrame } from "../../tests/helpers/sse.js";
import { fileFromFlat, flatFromFile } from "../../src/server/config/file-layout.js";

/**
 * The model, for a test that drives real turns: a local server the test runs
 * with `Bun.serve`, speaking the OpenAI Responses stream, and the app's
 * `openai` provider pointed at it. The pieces here are the ones every such
 * test wrote for itself: a reply, the stream that carries it, what a request
 * showed the model, and the seed and check that keep a turn off any real
 * provider.
 */

/** What a model step answers: text, or one function call. */
export type ModelOut = string | { text: string } | { call: { name: string; args: Record<string, unknown> } };
type ResponseEvent = Record<string, unknown>;

/** What a stub reply says it used. No test reads these numbers; a test whose
 *  stream sent other ones passes its own, so its frames stay as they were. */
export const STUB_USAGE: Record<string, unknown> = { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } };

/** One model response as its five events: created, the item added, its whole
 *  text or arguments in one delta, the item done, completed. The item ids
 *  derive from `id` (`msg_`, `fc_`, `call_`, `resp_` before it), so a call's
 *  result comes back under `call_<id>`. */
export function responseEvents(id: string, out: ModelOut, usage: Record<string, unknown> = STUB_USAGE): ResponseEvent[] {
  const reply = typeof out === "string" ? { text: out } : out;
  if ("text" in reply) {
    const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text, annotations: [] }] };
    return [
      { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: reply.text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage } }
    ];
  }
  const item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: reply.call.name, arguments: JSON.stringify(reply.call.args), status: "completed" };
  return [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage } }
  ];
}

/** One model response, sent whole at once. */
export function respond(id: string, out: ModelOut, usage?: Record<string, unknown>): Response {
  return new Response(responseEvents(id, out, usage).map((event) => sseFrame({ data: event })).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** One event of a scripted stream, sent after `after` settles and then
 *  `wait` ms more. */
export interface PacedEvent {
  wait?: number;
  after?: Promise<unknown>;
  event: ResponseEvent;
}

/** A response sent an event at a time, on the test's script: for a test that
 *  watches the page while a turn is still being written. */
export function paced(steps: PacedEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const step of steps) {
          if (step.after) await step.after;
          if (step.wait) await Bun.sleep(step.wait);
          controller.enqueue(encoder.encode(sseFrame({ data: step.event })));
        }
        controller.close();
      } catch { /* the client went away */ }
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

/** Every string in a value, depth first. */
export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** Every string in a request's input, a line each: what the model was shown
 *  of the conversation, for telling which case or step a request is. */
export function shown(body: Record<string, unknown>): string {
  return strings(body.input ?? []).join("\n");
}

/** What the tools answered so far in a request's conversation, oldest first. */
export function toolOutputs(body: Record<string, unknown>): string[] {
  return ((body.input ?? []) as Array<Record<string, unknown>>)
    .filter((item) => item.type === "function_call_output")
    .map((item) => (typeof item.output === "string" ? item.output : JSON.stringify(item.output)));
}

const stubURL = (port: number | undefined) => `http://127.0.0.1:${port}/v1`;

/** In a `startServer` seed: points the configured `openai` provider at the
 *  stub on `port`, as a compatible gateway (which the stub is). `edit` changes
 *  the rest of the config in the same write. */
export function seedStubProvider(dataDir: string, port: number | undefined, edit?: (config: Record<string, any>) => void): void {
  const file = path.join(dataDir, "config.json");
  const config = (flatFromFile(JSON.parse(fs.readFileSync(file, "utf8"))) as unknown as Record<string, any>);
  config.models.providers.openai.type = "openai-compatible";
  config.models.providers.openai.baseURL = stubURL(port);
  edit?.(config);
  fs.writeFileSync(file, JSON.stringify(fileFromFlat(config), null, 2));
}

/** After boot: throws unless the server's `openai` provider is the stub on
 *  `port`, so a seed that did not take never sends a turn to a real provider. */
export async function assertStubProvider(baseUrl: string, port: number | undefined): Promise<void> {
  const settings = await (await fetch(`${baseUrl}/api/settings/config`)).json() as Record<string, any>;
  const openai = (settings.config ?? settings).models?.providers?.openai;
  if (openai?.baseURL !== stubURL(port)) throw new Error(`the provider is not the stub: ${JSON.stringify(openai)}`);
}
