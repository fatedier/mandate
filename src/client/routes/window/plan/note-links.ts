export interface NoteLinkContext {
  /** Null when the pane has nowhere to go (an archived worker's): it stays text. */
  paneHref(paneId: string): string | null;
  paneName(paneId: string): string | undefined;
  canvasTitle(canvasId: string): string | undefined;
  /** The repository's web address, from its git remote; null leaves commits
   *  and issue numbers as text. */
  webBase: string | null;
  /** The plan's highest step id: the plan writes its steps as `#N`, so a
   *  `#N` at or below it names a step, not an issue. */
  maxStepId: number;
}

type NoteToken =
  | { kind: "text"; text: string }
  | { kind: "pane"; paneId: string; label: string; href: string }
  | { kind: "canvas"; canvasId: string; label: string }
  | { kind: "web"; label: string; href: string };

// One alternation, tried in order at each position:
//   url | pane | canvas | owner/repo#N | #N | commit.
// Each alternative is anchored on a boundary, so a token is never cut out of a
// longer word. A pane id takes the same boundary as firstPaneId: anything but
// a word character or `%` before it, so `100%5` is not a pane and `在%133`
// (Chinese has no spaces) is. A bare `repo#N` has no owner: the owner/repo
// branch needs a `/`, and `#N` refuses a `#` glued to a word, so it stays text.
// A hex word after `#` is a colour (`#a1b2c3d4`), and one inside a path or a
// file name (`dist/c0ffee1.js`) is a name, not a commit. A URL stops at a
// backtick, since notes are Markdown-ish.
const TOKEN = /(https?:\/\/[^\s<>`]+)|(?<![\w%])(%\d+)\b|(?<![\w-])(cnv_[A-Za-z0-9_-]{11})(?![\w-])|(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)\b|(?<![\w/#.-])#(\d+)\b|(?<![\w#/.-])([0-9a-f]{7,40})(?![\w/-]|\.\w)/g;

/** A hex word reads as a commit only with a letter and at least two digits:
 *  a real 7-character prefix nearly always has both, and words like
 *  "deadbee" or "face2face" do not. */
function isCommit(word: string): boolean {
  return /[a-f]/.test(word) && (word.match(/\d/g)?.length ?? 0) >= 2;
}

/** The owner in `owner/repo#N`. Two shapes read like one and are not: a
 *  number (`PR#12/issue#34`) and a Go test or fuzz name
 *  (`FuzzDecode/seed#0`, `TestParse/empty#01`). */
function isRepoOwner(owner: string): boolean {
  return !/^\d+$/.test(owner) && !/^(?:Test|Fuzz|Benchmark|Example)[A-Z_]/.test(owner);
}

/** A `#N` names one of the plan's steps unless the words before it say it
 *  is a pull request or an issue. */
function isStepRef(note: string, at: number, n: number, maxStepId: number): boolean {
  return n <= maxStepId && !/\b(?:PR|pull request|pull|MR|issue)[\s:(]*$/i.test(note.slice(Math.max(0, at - 40), at));
}

/** Bitbucket serves a commit under `commits/`; GitHub and GitLab under `commit/`. */
function commitPath(webBase: string): string {
  return new URL(webBase).hostname === "bitbucket.org" ? "commits" : "commit";
}

/** A URL runs to the next space; trailing punctuation, and a closing
 *  parenthesis or bracket the URL did not open, belong to the sentence. */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last && ".,;:!?'\"".includes(last)) { end--; continue; }
    if (last === ")" || last === "]") {
      const [open, close] = last === ")" ? [/\(/g, /\)/g] : [/\[/g, /\]/g];
      const body = url.slice(0, end);
      if ((body.match(close)?.length ?? 0) > (body.match(open)?.length ?? 0)) { end--; continue; }
    }
    return url.slice(0, end);
  }
}

/** A step note as text and links. A pane shows its name when the snapshot
 *  knows one; a report shows its title. */
export function noteTokens(note: string, ctx: NoteLinkContext): NoteToken[] {
  const tokens: NoteToken[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev?.kind === "text") prev.text += text;
    else tokens.push({ kind: "text", text });
  };
  for (const m of note.matchAll(TOKEN)) {
    const [matched, rawUrl, pane, canvas, repo, repoIssue, issue, commit] = m;
    const url = rawUrl ? trimUrl(rawUrl) : undefined;
    const whole = url ?? matched;
    let token: NoteToken | null = null;
    if (url) token = { kind: "web", label: url, href: url };
    else if (pane) {
      const href = ctx.paneHref(pane);
      if (href) token = { kind: "pane", paneId: pane, label: ctx.paneName(pane) ?? pane, href };
    }
    else if (canvas) token = { kind: "canvas", canvasId: canvas, label: ctx.canvasTitle(canvas) ?? canvas };
    else if (repo && repoIssue && ctx.webBase && isRepoOwner(repo.slice(0, repo.indexOf("/")))) token = { kind: "web", label: whole, href: `${new URL(ctx.webBase).origin}/${repo}/issues/${repoIssue}` };
    else if (issue && ctx.webBase && !isStepRef(note, m.index!, Number(issue), ctx.maxStepId)) token = { kind: "web", label: whole, href: `${ctx.webBase}/issues/${issue}` };
    else if (commit && ctx.webBase && isCommit(commit)) token = { kind: "web", label: commit, href: `${ctx.webBase}/${commitPath(ctx.webBase)}/${commit}` };
    if (!token) continue;
    pushText(note.slice(last, m.index));
    tokens.push(token);
    last = m.index! + whole.length;
  }
  pushText(note.slice(last));
  return tokens;
}
