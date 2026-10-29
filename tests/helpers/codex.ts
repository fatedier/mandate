import { createCodexOAuthLanguageModel } from "../../src/server/modules/codex/codex-oauth-provider.js";
import { saveCodexTokens, type AuthStoreFile } from "../../src/server/modules/codex/codex-auth-store.js";
import type { HttpClient } from "../../src/server/platform/http/http-client.js";
import { MemoryJsonStore } from "./memory-json-store.js";

export function codexAuthStore() {
  const store = new MemoryJsonStore<AuthStoreFile>({});
  saveCodexTokens("codex", {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 3600
  }, store);
  return store;
}

export function codexTestModel(httpClient: HttpClient, baseURL?: string) {
  return createCodexOAuthLanguageModel({
    providerName: "codex", model: "gpt-5.5", authStore: codexAuthStore(), httpClient, baseURL
  });
}

export function codexEvents(options: {
  id?: string;
  text?: string;
  phase?: "commentary" | "final_answer";
  endTurn?: unknown;
  encryptedReasoning?: string;
  toolCall?: { callId: string; name: string; args: string };
  terminalType?: "response.completed" | "response.incomplete" | "response.failed";
  incompleteReason?: string;
} = {}): Array<Record<string, unknown>> {
  const id = options.id ?? "1";
  const events: Array<Record<string, unknown>> = [{
    type: "response.created",
    response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" }
  }];
  const output: Array<Record<string, unknown>> = [];
  let index = 0;
  if (options.encryptedReasoning) {
    const reasoning = {
      type: "reasoning", id: `rs_${id}`, summary: [], encrypted_content: options.encryptedReasoning
    };
    events.push(
      { type: "response.output_item.added", output_index: index, item: { ...reasoning, encrypted_content: null } },
      { type: "response.output_item.done", output_index: index++, item: reasoning }
    );
    output.push(reasoning);
  }
  if (options.text !== undefined) {
    const message = {
      type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
      ...(options.phase ? { phase: options.phase } : {}),
      content: [{ type: "output_text", text: options.text, annotations: [] }]
    };
    events.push(
      { type: "response.output_item.added", output_index: index, item: { ...message, content: [] } },
      { type: "response.output_text.delta", item_id: message.id, output_index: index, content_index: 0, delta: options.text },
      { type: "response.output_item.done", output_index: index++, item: message }
    );
    output.push(message);
  }
  if (options.toolCall) {
    const call = {
      type: "function_call", id: `fc_${id}`, call_id: options.toolCall.callId,
      name: options.toolCall.name, arguments: options.toolCall.args, status: "completed"
    };
    events.push(
      { type: "response.output_item.added", output_index: index, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: call.id, output_index: index, delta: call.arguments },
      { type: "response.output_item.done", output_index: index, item: call }
    );
    output.push(call);
  }
  events.push({
    type: options.terminalType ?? "response.completed",
    sequence_number: events.length,
    response: {
      id: `resp_${id}`, status: "completed", output,
      ...(options.endTurn !== undefined ? { end_turn: options.endTurn } : {}),
      ...(options.incompleteReason ? { incomplete_details: { reason: options.incompleteReason } } : {}),
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }
    }
  });
  return events;
}

export function codexSse(events: Array<Record<string, unknown>>, chunkSize?: number): Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + (chunkSize ?? bytes.length));
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    }
  }), { headers: { "content-type": "text/event-stream" } });
}
