/** A manager thread the user opened beside the personal agent, as a tab in its right
 *  panel. Kept on the server, so every device shows the same tabs. */
export interface ThreadTabDto {
  threadId: string;
  createdAt: string;
}

export type ThreadTabsResponse = { tabs: ThreadTabDto[] } | { error: string };
