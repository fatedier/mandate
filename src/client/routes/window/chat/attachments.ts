import type { AgentMessageAttachment } from "@shared/agent-message-types";

/**
 * Attachments arrive as base64 rather than as a URL the browser can fetch, so
 * every surface that shows one has to build the data URI itself. Composing it
 * in one place keeps the media type and the payload from drifting apart
 * between the composer and the transcript.
 */
export function imageAttachmentSrc(attachment: AgentMessageAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`;
}
