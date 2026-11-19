/** The heading one line opens with, or null: a bolded phrase at its start
 *  ("**Checking the changelog format**"), as OpenAI's summaries head each
 *  part. Bold inside a sentence is not a heading, and one still streaming
 *  (no closing marks yet) is none. */
function lineHeading(raw: string): string | null {
  const line = raw.trim().replace(/^#+\s*/, "");
  const match = /^\*\*(.+?)\*\*/.exec(line);
  return match?.[1]?.trim() || null;
}

/** The newest heading of a summary that streams in parts (by id, in the
 *  order they began; joined, a paragraph each), worked out as it arrives:
 *  each delta is read once, with the line it ends. Null before the first. */
export class ReasoningHeadings {
  private readonly parts = new Map<string, { heading: string | null; line: string }>();

  /** A part begins: it keeps its place among the parts. */
  open(id: string): void {
    if (!this.parts.has(id)) this.parts.set(id, { heading: null, line: "" });
  }

  add(id: string, delta: string): void {
    this.open(id);
    const part = this.parts.get(id)!;
    const lines = (part.line + delta).split("\n");
    part.line = lines.pop() ?? "";
    for (const line of lines) part.heading = lineHeading(line) ?? part.heading;
  }

  /** The newest heading over the parts joined: a line still streaming
   *  stands when it already is one. */
  latest(): string | null {
    let heading: string | null = null;
    for (const part of this.parts.values()) heading = lineHeading(part.line) ?? part.heading ?? heading;
    return heading;
  }
}
