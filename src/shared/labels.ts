/** A label on a task or on a thread: a name on one line, at most LABEL_MAX
 *  characters, compared without regard to case. Tasks and threads share
 *  their names: the first spelling in use on either is the one kept. */
export const LABEL_MAX = 40;

/** What is said when a name is not a label. */
export const LABEL_REFUSED = "A label is a word or two: at most 40 characters.";

/** How labels are compared: without regard to case. */
export const labelKey = (name: string): string => name.toLowerCase();

/** The name as it is kept (trimmed), or null when it is not a label. "."
 *  and ".." are none: a label is taken off by its name in the address, where
 *  a URL folds those two away, escaped or not. */
export function labelName(raw: string): string | null {
  const name = raw.trim();
  return !name || name.length > LABEL_MAX || /[\r\n]/.test(name) || name === "." || name === ".." ? null : name;
}
