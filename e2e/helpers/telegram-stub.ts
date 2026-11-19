/**
 * A Telegram Bot API stand-in for e2e: the bot is "@mandate_example_bot",
 * one private chat (424242) has written to it, and every call is kept so a
 * test can read what Mandate sent, edited and deleted. Never the real API:
 * the server under test is pointed here by `notifications.telegramApiBase`.
 */
export interface TelegramCall {
  method: string;
  token: string;
  body: Record<string, unknown>;
}

export interface TelegramStub {
  url: string;
  calls: TelegramCall[];
  stop(): void;
}

export function startTelegramStub(): TelegramStub {
  const calls: TelegramCall[] = [];
  let nextMessageId = 500;
  const answer = (result: unknown) => Response.json({ ok: true, result });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(request.url).pathname);
      if (!match) return new Response("not here", { status: 404 });
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const [, token, method] = match;
      calls.push({ method: method!, token: token!, body });
      switch (method) {
        case "getMe": return answer({ id: 1, is_bot: true, first_name: "Mandate", username: "mandate_example_bot" });
        case "getUpdates": return answer([{ update_id: 1, message: { message_id: 1, chat: { id: 424242, type: "private" }, text: "hi" } }]);
        case "sendMessage": return answer({ message_id: nextMessageId++ });
        case "editMessageText": return answer({ message_id: body.message_id });
        case "deleteMessage": return answer(true);
        default: return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      }
    }
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}
