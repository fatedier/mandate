import { useMediaQuery } from "./useMediaQuery";

/** Mobile viewport breakpoint. Aligned with Tailwind's default `md:` boundary
 *  (md: applies at min-width 768px), so "mobile" in JS and "mobile" in CSS
 *  agree on the same threshold. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
