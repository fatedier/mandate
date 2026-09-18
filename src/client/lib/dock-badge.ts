/** What to hand the Dock: a positive whole count, or "no badge". Kept out of
 *  the component file so fast refresh sees only a component there. */
export function badgeValue(count: number): number | undefined {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : undefined;
}
