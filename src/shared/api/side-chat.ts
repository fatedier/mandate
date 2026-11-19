/** A side chat: the personal agent's conversation forked to talk one topic
 *  over apart from it, listed under the agent until it is sent or
 *  discarded. Its messages are a thread's (the thread routes). */
export interface SideChatDto {
  id: string;
  /** The user's title, else its first line, else "New side chat". */
  title: string;
  named: boolean;
  createdAt: string;
  lastActivityAt: string;
  lastVisibleSeq: number;
  seenSeq: number;
  /** A turn of its runs, or a background command of its is open. */
  working: boolean;
}

export interface SideChatsDto {
  sideChats: SideChatDto[];
}

export interface SideChatUpdatedDto {
  sideChat: SideChatDto;
}

export interface SideChatDeletedDto {
  id: string;
}
