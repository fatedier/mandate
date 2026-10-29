import type { AgentMessage } from "./agent-store.js";
import { isToolImageResultContent } from "./wake-message-adapter.js";

/**
 * An image a model is sent is at most this long on its longer side: a
 * provider may refuse a long, narrow screenshot that it takes once fitted to
 * 2000 pixels. The stored image is left as it is: the page shows the original.
 */
export const MODEL_IMAGE_LONG_SIDE = 2000;
/** Past this many pixels an image is not decoded to be made smaller (~200 MB). */
const MAX_PIXELS = 50_000_000;
/** How much fitted image the process keeps; the oldest goes first. */
const KEEP_BYTES = 64 * 1024 * 1024;

export interface ModelImage {
  data: string;
  mediaType: string;
}

interface StoredImage {
  id: string;
  data: string;
  mediaType: string;
}

type Fit = (bytes: Uint8Array, mediaType: string) => Promise<ModelImage | null>;

/** The image at MODEL_IMAGE_LONG_SIDE, in its own kind (JPEG stays JPEG, the
 *  rest PNG, which keeps text sharp); null when it is within that already. */
async function bunFit(bytes: Uint8Array, mediaType: string): Promise<ModelImage | null> {
  const { width, height } = await new Bun.Image(bytes, { maxPixels: MAX_PIXELS }).metadata();
  if (Math.max(width, height) <= MODEL_IMAGE_LONG_SIDE) return null;
  const smaller = new Bun.Image(bytes, { maxPixels: MAX_PIXELS })
    .resize(MODEL_IMAGE_LONG_SIDE, MODEL_IMAGE_LONG_SIDE, { fit: "inside", withoutEnlargement: true });
  const jpeg = mediaType === "image/jpeg";
  const out = await (jpeg ? smaller.jpeg({ quality: 85 }) : smaller.png()).bytes();
  return { data: Buffer.from(out).toString("base64"), mediaType: jpeg ? "image/jpeg" : "image/png" };
}

interface Placed {
  messageId: string;
  image: StoredImage;
}

function imagesIn(messages: AgentMessage[]): Placed[] {
  return messages.flatMap((message): Placed[] => {
    const content = message.content;
    if (content.type === "text") {
      return (content.attachments ?? []).filter((attachment) => attachment.type === "image").map((image) => ({ messageId: message.id, image }));
    }
    if (content.type === "tool_result" && isToolImageResultContent(content.result)) return [{ messageId: message.id, image: content.result.image }];
    return [];
  });
}

/** An image, told by the message it is in: a screenshot viewed again under one
 *  path keeps its image id, but is another message. A message is not rewritten
 *  but by retention, which changes its length. */
const keyOf = (messageId: string, image: StoredImage) => `${messageId}\0${image.id}\0${image.data.length}`;

/** The copies made for one prompt, kept for it whatever the cache lets go. */
export interface FittedImages {
  /** What to send in this image's place; null: send it as it is. */
  forModel(image: StoredImage, messageId: string): ModelImage | null;
}

/**
 * The images a model is sent, made small enough first. `prepare` fits a
 * prompt's images before it is built (one at a time, whatever thread asks: a
 * decode holds the whole image) and gives the copies for that prompt; a
 * bounded cache keeps them for the next prompts. A fitted image stays the same
 * bytes, so the provider's prompt cache keeps it.
 */
export class ModelImageFitter {
  private readonly cache = new Map<string, ModelImage | null>();
  private keptBytes = 0;
  private turn: Promise<void> = Promise.resolve();
  private readonly fit: Fit;
  private readonly keepBytes: number;

  constructor(options: { fit?: Fit; keepBytes?: number } = {}) {
    this.fit = options.fit ?? bunFit;
    this.keepBytes = options.keepBytes ?? KEEP_BYTES;
  }

  async prepare(messages: AgentMessage[]): Promise<FittedImages> {
    const pinned = new Map<string, ModelImage>();
    for (const { messageId, image } of imagesIn(messages)) {
      const key = keyOf(messageId, image);
      let fitted = this.cache.get(key);
      if (fitted === undefined) {
        const run = this.turn.then(() => this.fitOne(key, image));
        this.turn = run.then(() => {}, () => {});
        fitted = await run;
      }
      if (fitted) pinned.set(key, fitted);
    }
    return { forModel: (image, messageId) => pinned.get(keyOf(messageId, image)) ?? null };
  }

  private async fitOne(key: string, image: StoredImage): Promise<ModelImage | null> {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    let fitted: ModelImage | null = null;
    try {
      fitted = await this.fit(new Uint8Array(Buffer.from(image.data, "base64")), image.mediaType);
    } catch {
      // Not readable here, or too many pixels: it goes as it is.
    }
    this.cache.set(key, fitted);
    if (fitted) {
      this.keptBytes += fitted.data.length;
      for (const [oldest, kept] of this.cache) {
        if (this.keptBytes <= this.keepBytes || oldest === key) break;
        this.cache.delete(oldest);
        this.keptBytes -= kept?.data.length ?? 0;
      }
    }
    return fitted;
  }
}

/** The process's one fitter: every thread's steps and compactions share it. */
export const modelImages = new ModelImageFitter();
