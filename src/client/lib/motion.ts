/** Whether the person lets things move: false once they ask their system
 *  for less motion (prefers-reduced-motion), and where it cannot be asked. */
export function motionAllowed(): boolean {
  return typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
