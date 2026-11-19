import { createPatch, OMIT_HEADERS } from "diff";

/** Diffing gives up past this edit distance (in lines) or time: a revision
 *  that rewrote a long skill whole is shown as its text, not as a patch,
 *  rather than block the server. */
const PATCH_MAX_EDIT_LENGTH = 2_000;
const PATCH_TIMEOUT_MS = 200;

/** A revision's change against the one before, as unified hunks (no file
 *  headers); null when it could not be worked out within the limits. */
export function revisionPatch(before: string, after: string): string | null {
  const patch = createPatch("skill", withNewline(before), withNewline(after), undefined, undefined, {
    context: 3,
    maxEditLength: PATCH_MAX_EDIT_LENGTH,
    timeout: PATCH_TIMEOUT_MS,
    headerOptions: OMIT_HEADERS
  });
  return patch ?? null;
}

/** A body without its final newline still ends its last line, so it is not
 *  shown as changed for that alone. */
const withNewline = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);
