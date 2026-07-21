import { CHAT_PANEL_WIDTH_DEFAULT, CHAT_PANEL_WIDTH_MIN } from "@/store/ui";

/** Keep both panes usable on small desktops, while allowing an equal split
 *  beyond the old 900px chat limit on wide screens. */
export function getChatPanelWidth(availableWidth: number, ratio: number): number {
  if (availableWidth <= 0) return CHAT_PANEL_WIDTH_DEFAULT;
  const minimum = Math.min(CHAT_PANEL_WIDTH_MIN, availableWidth / 2);
  const desired = availableWidth * ratio;
  return Math.max(minimum, Math.min(availableWidth - minimum, desired));
}
