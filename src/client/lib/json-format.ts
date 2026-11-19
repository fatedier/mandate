import { createScanner, format, parseTree, type ParseError } from "jsonc-parser";

/** A JSON file's name: comments and trailing commas are read too. */
export const isJsonName = (name: string): boolean => /\.jsonc?$/i.test(name);

/** Formatted text longer than this is shown without colours: a span per
 *  token makes the page slow to draw past it (measured in the e2e Chromium:
 *  2.3 MB with 128k coloured spans showed in about 1 s and scrolled at 60 fps). */
export const JSON_COLOR_MAX_CHARS = 4_000_000;

/** The kinds a formatted JSON text colours; punctuation, comments and
 *  spaces take the text's own colour. */
export type JsonTokenKind = "key" | "string" | "number" | "literal";

/** A run of the text: coloured by its kind, or plain (null). */
export type JsonRun = [text: string, kind: JsonTokenKind | null];

const READ = { allowTrailingComma: true, disallowComments: false };

/** The text indented by two spaces, a value per line; only spaces and line
 *  breaks change, so every number, key and comment stays as written. Null
 *  when the text is not JSON. */
export function formatJson(text: string): string | null {
  const errors: ParseError[] = [];
  parseTree(text, errors, READ);
  if (errors.length > 0) return null;
  // The edits put together in one pass: the library's applyEdits rebuilds the
  // whole text once per edit (6.5 s for a 1.9 MB file, 6 ms this way).
  const edits = format(text, undefined, { tabSize: 2, insertSpaces: true, eol: "\n" }).sort((a, b) => a.offset - b.offset);
  const pieces: string[] = [];
  let at = 0;
  for (const edit of edits) {
    pieces.push(text.slice(at, edit.offset), edit.content);
    at = edit.offset + edit.length;
  }
  pieces.push(text.slice(at));
  return pieces.join("");
}

// jsonc-parser's SyntaxKind values: a const enum, not readable as a value
// under isolatedModules.
const COLON = 6;
const NULL = 7;
const TRUE = 8;
const FALSE = 9;
const STRING = 10;
const NUMBER = 11;
const LINE_COMMENT = 12;
const BLOCK_COMMENT = 13;
const LINE_BREAK = 14;
const SPACE = 15;
const EOF = 17;

const TRIVIA = new Set([LINE_COMMENT, BLOCK_COMMENT, LINE_BREAK, SPACE]);

/** The text in runs by token: a string before a colon is a key. Runs of
 *  plain text are joined, so a line holds a few elements, not one per mark. */
export function jsonRuns(text: string): JsonRun[] {
  const scanner = createScanner(text, false);
  const tokens: Array<{ kind: number; from: number; to: number }> = [];
  for (let kind: number = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
    const from = scanner.getTokenOffset();
    tokens.push({ kind, from, to: from + scanner.getTokenLength() });
  }
  const runs: JsonRun[] = [];
  const plain = (piece: string) => {
    const last = runs.at(-1);
    if (last && last[1] === null) last[0] += piece;
    else runs.push([piece, null]);
  };
  for (let i = 0; i < tokens.length; i++) {
    const { kind, from, to } = tokens[i]!;
    const piece = text.slice(from, to);
    const colour = kindOf(kind, () => {
      let next = i + 1;
      while (next < tokens.length && TRIVIA.has(tokens[next]!.kind)) next++;
      return tokens[next]?.kind === COLON;
    });
    if (colour) runs.push([piece, colour]);
    else plain(piece);
  }
  return runs;
}

function kindOf(kind: number, beforeColon: () => boolean): JsonTokenKind | null {
  if (kind === STRING) return beforeColon() ? "key" : "string";
  if (kind === NUMBER) return "number";
  if (kind === TRUE || kind === FALSE || kind === NULL) return "literal";
  return null;
}
