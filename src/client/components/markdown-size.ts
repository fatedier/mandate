/** A markdown block's text size and leading, for MarkdownView. */
export function markdownSizeClass({ dense = false, small = false }: { dense?: boolean; small?: boolean }): string {
  // Small keeps the headings' three steps (MarkdownView's h1–h3 render as
  // h3–h5), one size range down, and no space above the first block.
  if (small) {
    return "text-xs leading-[1.5] [&_h3]:text-sm [&_h4]:text-xs [&_h5]:text-xs [&_h5]:text-muted-foreground [&>*:first-child]:mt-0";
  }
  return dense ? "text-sm leading-[1.45]" : "text-sm leading-[1.6]";
}
