/** How tmux reads a send_keys call's arguments — pure, and imported by both
 *  the details view and the run line. */

/** One press in a send_keys call: a key by its name (`Enter`, `C-c`), or
 *  text typed as it is. */
export interface KeyPress {
  kind: "key" | "typed";
  text: string;
}

/** tmux's names for keys that are not a character: `Enter`, `BSpace`, `F5`,
 *  and any key with a modifier (`C-c`, `M-x`, `S-Tab`). A bare word tmux does
 *  not know is typed as it is, and so is a bare character. `^C` is tmux's
 *  other spelling of C-c. */
const NAMED_KEY = /^(?:(?:[CMS]-)+\S|\^\S|(?:[CMS]-)*(?:Enter|Escape|Tab|BTab|Space|BSpace|Up|Down|Left|Right|Home|End|IC|DC|PageUp|PageDown|PgUp|PgDn|PPage|NPage|F(?:[1-9]|1[0-2])))$/i;

/** A send_keys call's args as tmux reads them — but only in the forms the
 *  agents use: options first (getopt's way: they end at the first argument
 *  that is not one, or at `--`), of which only `-l` is read (every key after
 *  them is literal text); then a name tmux knows is a key and anything else
 *  typed. Any other option — `-H` hexadecimal codes, `-N` repeats, `-X`
 *  copy-mode commands, a cluster such as `-lR` — changes what the keys mean
 *  in ways a label would have to reimplement tmux to show, so a call with one
 *  is not read at all: null, and it is shown as sent. */
export function keyPresses(args: string[]): KeyPress[] | null {
  const presses: KeyPress[] = [];
  let options = true;
  let literal = false;
  for (const arg of args) {
    if (options) {
      if (arg === "--") {
        options = false;
        continue;
      }
      if (arg === "-l") {
        literal = true;
        continue;
      }
      if (arg.length > 1 && arg.startsWith("-")) return null;
      options = false;
    }
    presses.push({ kind: !literal && NAMED_KEY.test(arg) ? "key" : "typed", text: arg });
  }
  return presses;
}

/** Presses as one line of text, as tmux sends them: typed text in quotes,
 *  run together with no space added between arguments (`["ls", "-la"]`
 *  types `ls-la`), keys by name. */
export function pressesText(presses: KeyPress[]): string {
  const parts: string[] = [];
  let typed: string | null = null;
  for (const press of presses) {
    if (press.kind === "typed") {
      typed = (typed ?? "") + press.text;
      continue;
    }
    if (typed !== null) parts.push(JSON.stringify(typed));
    typed = null;
    parts.push(press.text);
  }
  if (typed !== null) parts.push(JSON.stringify(typed));
  return parts.join(" ");
}
