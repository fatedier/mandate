/** The newest heading a reasoning summary has reached: the last line that
 *  opens with a bolded phrase ("**Checking the changelog format**"), as
 *  OpenAI's summaries head each part.
 *  Bold inside a sentence is not a heading, and one still streaming (no
 *  closing marks yet) does not replace the last. Null before the first. */
export function latestReasoningHeading(text: string): string | null {
  let heading: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^#+\s*/, "");
    const match = /^\*\*(.+?)\*\*/.exec(line);
    const found = match?.[1]?.trim();
    if (found) heading = found;
  }
  return heading;
}
