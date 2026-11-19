import { formatCalendarDate } from "@/lib/format";

/** What an archived thread's conversation says where its composer was. */
export function archivedReadOnlyNote(archivedAt: string): string {
  return `Archived on ${formatCalendarDate(archivedAt)}. You can read it here; nothing more can be sent.`;
}
