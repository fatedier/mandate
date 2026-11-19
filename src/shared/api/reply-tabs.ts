/** A reply the user opened in a thread's right panel (the personal agent's or a
 *  manager thread's). Kept on the server, so every device shows the same tabs.
 *  `text` is the reply as Copy takes it (the whole turn), as it was when
 *  opened: later changes to the chat do not reach it. */
export interface ReplyTabDto {
  id: string;
  threadId: string;
  /** The turn's last reply message, where its action line is. */
  messageId: string;
  text: string;
  /** When that message was written. */
  repliedAt: string;
  createdAt: string;
}

export type ReplyTabsResponse = { tabs: ReplyTabDto[] } | { error: string };

/** The longest reply a tab keeps. */
export const MAX_REPLY_TAB_CHARS = 200_000;
