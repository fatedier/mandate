import type { AgentMessageAttachment, ToolImageResultContent } from "@shared/agent-message-types";
import { apiPath } from "@/lib/api-base";

/**
 * Where an image is drawn from. One the server sent comes with its address
 * and no bytes: a thumbnail for the transcript, the original for the viewer,
 * each fetched only when drawn. One composed or just sent has its own bytes,
 * shown as they are.
 */
export function imageSources(image: { mediaType: string; data: string; url?: string }): { thumb: string; original: string } {
  if (image.url) {
    const original = apiPath(image.url);
    return { thumb: `${original}?size=thumb`, original };
  }
  const inline = `data:${image.mediaType};base64,${image.data}`;
  return { thumb: inline, original: inline };
}

/** The composer's own attachments: always their bytes. */
export function imageAttachmentSrc(attachment: AgentMessageAttachment): string {
  return imageSources(attachment).original;
}

/** What a view_image call returned, when that is an image. */
export function toolImageOf(value: unknown): ToolImageResultContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "view_image_result" || typeof record.message !== "string") return null;
  const image = record.image;
  if (!image || typeof image !== "object" || Array.isArray(image)) return null;
  const img = image as Record<string, unknown>;
  return img.type === "image" && typeof img.displayPath === "string" && typeof img.mediaType === "string"
    && typeof img.data === "string" && typeof img.sizeBytes === "number"
    ? (value as ToolImageResultContent)
    : null;
}
