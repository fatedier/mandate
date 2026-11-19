const DAY_MS = 24 * 60 * 60 * 1000;

/** "today", "1 day ago", "12 days ago", "3 months ago". */
export function describeAge(iso: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < DAY_MS) return "today";
  const days = Math.floor(elapsed / DAY_MS);
  if (days === 1) return "1 day ago";
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}
