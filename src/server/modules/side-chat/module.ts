import type { Context } from "hono";
import { getBunServer } from "hono/bun";
import type { MandateModule } from "../module.js";
import { scopePack } from "../../runtime/scope-packs.js";
import { buildSideChatScope } from "./side-chat-scope.js";
import { initializeSideChatSchema } from "./side-chat-sends.js";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { SideChatDto, SideChatsDto } from "../../../shared/api/side-chat.js";
import type { SideChatResult } from "./side-chat-service.js";

const answer = <T extends object>(c: Context, result: SideChatResult<T>, status: 200 | 201 = 200) =>
  "error" in result && "status" in result ? c.json({ error: result.error }, result.status) : c.json(result, status);

/** Longer than an end waits for a compaction (SideChatService), and than a
 *  summary's call: Bun's idle timeout (10 s) would cut the request first. */
const LONG_REQUEST_SECONDS = 180;
const keepOpen = (c: Context) => {
  // In-process app.request() calls have no Bun server.
  const server = c.env ? getBunServer<{ timeout?: (request: Request, seconds: number) => void }>(c) : undefined;
  server?.timeout?.(c.req.raw, LONG_REQUEST_SECONDS);
};

const body = async (c: Context): Promise<Record<string, unknown>> => {
  const parsed = await c.req.json().catch(() => null) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
};

/** Side chats: the personal agent's conversation forked into threads of
 *  their own. Their messages go through the thread routes. */
export const sideChatModule: MandateModule = {
  id: "side-chat",
  schema: [initializeSideChatSchema],
  scopePacks: (ctx) => [scopePack("side_chat", () => buildSideChatScope(ctx.sideChat))],
  mountRoutes: (app, { deps }) => {
    const chats = deps.sideChats;
    if (!chats) return;
    app.post(API_ROUTES.sideChats, (c) => c.json({ sideChat: chats.open() satisfies SideChatDto }, 201));
    app.get(API_ROUTES.sideChats, (c) => c.json({ sideChats: chats.list() } satisfies SideChatsDto));
    app.patch(API_ROUTES.sideChat, async (c) => {
      const renamed = chats.rename(c.req.param("id"), (await body(c)).title);
      return answer(c, "error" in renamed ? renamed : { sideChat: renamed });
    });
    app.post(API_ROUTES.sideChatSeen, async (c) => {
      const seen = chats.markSeen(c.req.param("id"), (await body(c)).seq);
      return answer(c, "error" in seen ? seen : { sideChat: seen });
    });
    app.post(API_ROUTES.sideChatSummary, async (c) => {
      keepOpen(c);
      return answer(c, await chats.summary(c.req.param("id"), c.req.raw.signal));
    });
    app.post(API_ROUTES.sideChatSend, async (c) => {
      keepOpen(c);
      const input = await body(c);
      return answer(c, await chats.send(c.req.param("id"), { summary: input.summary, note: input.note }));
    });
    app.delete(API_ROUTES.sideChat, async (c) => {
      keepOpen(c);
      return answer(c, await chats.discard(c.req.param("id")));
    });
  }
};
