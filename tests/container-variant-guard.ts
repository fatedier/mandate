// Shared by the two transcript-row guards (`tool-call-card`, `chat-provenance-line`).
//
// Both rows layer their narrow layout under a single container variant and leave
// the wide layout as the unprefixed classes, so wide is unaffected by
// construction. Two different properties keep that true, and this module exists
// because guarding only the first one is what let the same bug back in twice:
//
//   1. NO OTHER WIDTH-BASED VARIANT may appear (`widthVariantOffenders`).
//   2. THE PARTS THAT MUST STAY VISIBLE MUST STAY VISIBLE (`hidingUtilities`).
//
// (1) alone is a ban list: it proves nothing about what remains. A later
// `@max-[34rem]:hidden` on the detail span is a perfectly well-formed narrow
// variant that silently reverts the whole change, and `@max-[34rem]:sr-only` on
// a label passes any assertion that merely compares two token identities. So
// the rows also assert (2), positively, on the spans that carry the meaning.

/** The one container variant these rows are allowed to use. */
export const NARROW_VARIANT = "@max-[34rem]";

/**
 * `className` is an SVGAnimatedString on icon elements, not a string, so read
 * the attribute rather than the property when walking a subtree.
 */
export function classTokens(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Split a Tailwind class into its variant segments and its final utility.
 *
 * Splits on `:` only at bracket depth 0, so an arbitrary property such as
 * `[overflow-anchor:none]` stays one utility instead of being read as a variant
 * named `[overflow-anchor`.
 */
export function splitVariants(token: string): { variants: string[]; utility: string } {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    if (ch === ":" && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return { variants: segments.slice(0, -1), utility: segments[segments.length - 1] ?? "" };
}

/** A viewport-width variant: `md:`, `max-lg:`, `min-[30rem]:`, `max-[30rem]:`. */
function isViewportWidthVariant(variant: string): boolean {
  return /^(max-)?(sm|md|lg|xl|2xl)$/.test(variant) || /^(min|max)-\[[^\]]*\]$/.test(variant);
}

/**
 * Every width-based variant in `tokens` that is not the sanctioned narrow one.
 *
 * The property is "the only width decision these rows may make is
 * `@max-[34rem]:`", which is narrower than "no `@` variant other than
 * `@max-`". Four things the looser spelling let through, all caught here:
 *
 *   - a container variant that is not leading: `dark:@[34rem]:inline`
 *   - a viewport breakpoint: `md:hidden` — it bypasses the container system
 *     entirely and decides on the window instead of the dock
 *   - `@max-` at the WRONG threshold: `@max-lg:`, `@max-[30rem]:` — the right
 *     direction, the wrong breakpoint
 *   - and it must NOT flag `@container` itself, which is a utility rather than
 *     a variant (no `:`), and is how the context is established in the first
 *     place.
 *
 * State variants (`hover:`, `dark:`, `group-*`, `data-*`) are untouched: they
 * do not decide layout by width.
 */
export function widthVariantOffenders(tokens: string[]): string[] {
  return tokens.filter((token) =>
    splitVariants(token).variants.some(
      (variant) =>
        (variant.startsWith("@") && variant !== NARROW_VARIANT) || isViewportWidthVariant(variant)
    )
  );
}

/**
 * Utilities that remove an element from view or shrink it to nothing. A span
 * carrying any of these — under any variant, or none — is not visible at some
 * width, which is the thing the rows must never do to the parts that carry
 * meaning.
 *
 * `min-w-0` and `truncate` are deliberately absent: they make an element YIELD
 * space, which is the intended behaviour, not disappear.
 */
const HIDING_UTILITIES = new Set([
  "hidden",
  "sr-only",
  "invisible",
  "collapse",
  "opacity-0",
  "w-0",
  "h-0",
  "size-0",
  "max-w-0",
  "max-h-0",
  "scale-0",
  "text-[0px]",
  "text-[0]"
]);

/**
 * Every token in `tokens` that would hide the element or zero its size, at any
 * width. Token-based on purpose: happy-dom does no layout and evaluates no
 * container queries, so a computed width here would be meaningless. The real
 * widths are measured in a browser.
 */
export function hidingUtilities(tokens: string[]): string[] {
  return tokens.filter((token) => HIDING_UTILITIES.has(splitVariants(token).utility));
}
