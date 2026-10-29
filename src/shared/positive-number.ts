/** A figure read from anywhere (stored metadata, a setting, the usage a
 *  provider reported) as a number when it is finite and above zero; null
 *  for anything else. */
export function positiveNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
