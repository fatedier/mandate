/** A token count as the app prints it: 8,473 reads "8.5k", 250,000 "250.0k".
 *  Shared so the server's own lines (the /context command) and the client's
 *  print a size alike. */
export function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  // Billions are not hypothetical here: a month of heavy use passes a billion
  // input tokens, which without this tier reads as "1234.5M".
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("en-US");
}
