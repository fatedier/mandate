import type { Hono } from "hono";
import { API_PATHS, API_ROUTES } from "../../../shared/api-contracts.js";
import type { AgentMessageAttachment, AgentMessageContent } from "../../../shared/agent-message-types.js";
import type { AgentStore } from "./agent-store.js";
import { isToolImageResultContent } from "./wake-message-adapter.js";

/**
 * A chat page carries each image's address, not its bytes: a transcript of
 * screenshots ran to megabytes a page, though most stay folded. The browser
 * fetches an image when it draws one, a thumbnail in the transcript and the
 * original when it is opened. The stored message keeps the bytes, for the
 * model.
 */

/** Served as images; anything else (an SVG can carry script) is not. */
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const THUMB_WIDTH = 400;
const THUMB_QUALITY = 75;
/** An image this small is its own thumbnail. */
const SMALL_ENOUGH = 64 * 1024;
/** An image in a message never changes. */
const CACHE = "private, max-age=31536000, immutable";
/** A thumbnail decodes the whole image, 4 bytes a pixel: past this many
 *  (~100 MB decoded) the original is served instead, and only so many are
 *  made at once, so a transcript of tall screenshots cannot run the server
 *  out of memory. */
const THUMB_MAX_PIXELS = 25_000_000;
const THUMBS_AT_ONCE = 2;

/** A WebP at most THUMB_WIDTH wide; rejects past THUMB_MAX_PIXELS. */
async function bunThumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  return new Bun.Image(bytes, { maxPixels: THUMB_MAX_PIXELS })
    .resize(THUMB_WIDTH, undefined, { withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .bytes();
}

class Gone extends Error {}

/** Runs at most `limit` of the tasks given it at once; the rest wait their
 *  turn, in order. One whose asker has gone (its signal aborted) leaves the
 *  queue and never runs: it rejects with Gone. */
function gate(limit: number) {
  let running = 0;
  const waiting: Array<{ go: () => void; signal: AbortSignal }> = [];
  const letIn = () => {
    while (running < limit && waiting.length > 0) {
      running += 1;
      waiting.shift()!.go();
    }
  };
  return async <T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw new Gone();
    if (running < limit) {
      running += 1;
    } else {
      await new Promise<void>((go, leave) => {
        const turn = { go, signal };
        waiting.push(turn);
        signal.addEventListener("abort", () => {
          const at = waiting.indexOf(turn);
          if (at < 0) return; // let in already: it finds out below
          waiting.splice(at, 1);
          leave(new Gone());
        }, { once: true });
      });
    }
    try {
      if (signal.aborted) throw new Gone();
      return await task();
    } finally {
      running -= 1;
      letIn();
    }
  };
}

/** The content as a browser gets it: each image's bytes swapped for its address. */
export function withImageAddresses<C extends AgentMessageContent>(messageId: string, content: C): C {
  if (content.type === "text" && content.attachments?.length) {
    return { ...content, attachments: content.attachments.map((attachment) => addressed(messageId, attachment)) };
  }
  if (content.type === "tool_result" && isToolImageResultContent(content.result)) {
    return { ...content, result: { ...content.result, image: addressed(messageId, content.result.image) } };
  }
  return content;
}

function addressed<I extends { id: string; data: string }>(messageId: string, image: I): I & { url: string } {
  return { ...image, data: "", url: API_PATHS.agentMessageImage(messageId, image.id) };
}

function storedImage(content: AgentMessageContent, imageId: string): AgentMessageAttachment | { mediaType: string; data: string } | null {
  if (content.type === "text") return content.attachments?.find((attachment) => attachment.id === imageId) ?? null;
  if (content.type === "tool_result" && isToolImageResultContent(content.result) && content.result.image.id === imageId) {
    return content.result.image;
  }
  return null;
}

export function mountMessageImageRoutes(app: Hono, deps: {
  agentStore: Pick<AgentStore, "getMessageById">;
  /** The thumbnail maker; Bun's own pipeline unless a test gives one. */
  makeThumbnail?: (bytes: Uint8Array) => Promise<Uint8Array>;
}): void {
  const makeThumbnail = deps.makeThumbnail ?? bunThumbnail;
  const inTurn = gate(THUMBS_AT_ONCE);
  app.get(API_ROUTES.agentMessageImage, async (c) => {
    const served = (body: Uint8Array<ArrayBuffer>, type: string) => new Response(body, {
      headers: { "Content-Type": type, "Cache-Control": CACHE, "X-Content-Type-Options": "nosniff" }
    });
    const notFound = () => c.json({ error: "image not found" }, 404);
    const read = () => {
      const message = deps.agentStore.getMessageById(c.req.param("messageId"));
      const image = message ? storedImage(message.content, c.req.param("imageId")) : null;
      return image && RASTER.has(image.mediaType)
        ? { mediaType: image.mediaType, bytes: Uint8Array.from(Buffer.from(image.data, "base64")) }
        : null;
    };
    if (c.req.query("size") !== "thumb") {
      const found = read();
      return found ? served(found.bytes, found.mediaType) : notFound();
    }
    // Read once let in: one waiting its turn holds only its address.
    try {
      return await inTurn(async () => {
        const found = read();
        if (!found) return notFound();
        const { bytes, mediaType } = found;
        if (bytes.length <= SMALL_ENOUGH) return served(bytes, mediaType);
        try {
          const thumb = await makeThumbnail(bytes);
          return thumb.length < bytes.length ? served(Uint8Array.from(thumb), "image/webp") : served(bytes, mediaType);
        } catch {
          // Bytes no codec here reads, or too many pixels to decode for a
          // thumbnail: the original is still what was viewed.
          return served(bytes, mediaType);
        }
      }, c.req.raw.signal);
    } catch (error) {
      if (error instanceof Gone) return new Response(null, { status: 499 });
      throw error;
    }
  });
}
