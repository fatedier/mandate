import * as fs from "node:fs";
import * as path from "node:path";
import type { Node } from "web-tree-sitter";
import { withBashTree } from "./bash-parser.js";

/**
 * The tool-call review's fast path: tells whether a bash command line is one
 * of the plain read-only forms agents run all day, so the review may skip it.
 * It never holds anything back: whatever it does not recognise goes to the
 * review, which is the protection; this only spares it the obvious.
 *
 * What it reads is the line: its structure, programs, flags, operands,
 * redirects and cds. Mandate runs each call as a fresh `bash -c`, so the
 * shell state a line can set lives in the line itself. What lies outside the
 * line is not checked and is taken as the user's own:
 *  - the environment the line runs in: variables, functions exported from
 *    bash, shell options, PATH, each tool's configuration;
 *  - the file system: links, and what a glob or a search meets;
 *  - a registered repository's own git configuration.
 * Secrets: a line that names a secret path is reviewed; what a search finds
 * by itself under a directory is a search's result, as the design lets
 * searches pass.
 */
export interface ReadOnlyContext {
  /** Where the line starts, absolute (the call's cwd, or the scope's workspace). */
  cwd: string;
  /** Repositories Mandate registered (project checkouts, the thread's worktree). */
  registeredRepos: readonly string[];
  maxLength?: number;
  /** Told each program the check read, with the words bash will pass it
   *  (its name first): what an end-to-end check compares with what bash
   *  really passes. */
  onCommand?: (argv: readonly string[]) => void;
  /** Files whose contents are secret wherever the line names them from
   *  (absolute): a settings file holding keys, say. */
  secretFiles?: readonly string[];
}

export type FastPathVerdict = { skip: true } | { skip: false; reason: string };

const DEFAULT_MAX_LENGTH = 10_000;

/** A table's entry by a word from the line: its own entries only, never
 *  what every object has (`constructor`, `toString`). */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
const SKIP: FastPathVerdict = { skip: true };
type Review = Extract<FastPathVerdict, { skip: false }>;
const review = (reason: string): Review => ({ skip: false, reason });

/** Where the line may stand once a statement has run: its possible working
 *  directories after a success and after a failure. A cd moves only the
 *  first; `a && b` runs b from a's successes, `a || b` from its failures, and
 *  a statement after `;` from either. */
interface Cwds {
  ok: readonly string[];
  failed: readonly string[];
}
type Outcome = Cwds | Review;
const isReview = (outcome: Outcome): outcome is Review => "reason" in outcome;
const unchanged = (cwds: readonly string[]): Cwds => ({ ok: cwds, failed: cwds });
const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/** Unquoted characters bash would expand or treat specially; `~` only where
 *  it expands (a word's start, or after `=` or `:`). */
const UNQUOTED_SPECIAL = /[{}*?[\]\\^#$`]|(^|[=:])~/;
const GLOB_ONLY = /^[^{}\\~^#$`]*$/;
/** Programs whose arguments a glob may expand into: none of their flags runs,
 *  writes or reads a list of files (a file named `-i` stays harmless). */
const GLOB_OK = new Set(["ls", "cat", "head", "tail", "stat"]);

/** Paths whose contents would go to the model provider once read: dotenv
 *  files (`.env`, `.env.local`, `.env-production`, `.envrc`), key and
 *  credential folders, a process's environment (`/proc/<pid>/environ`). Any
 *  case: macOS's file system ignores it. */
const SECRET_PATH = new RegExp([
  "(^|\\/)\\.env[^/]*(\\/|$)", "(^|\\/)environ$", "(^|\\/)\\.ssh(\\/|$)", "(^|\\/)\\.aws(\\/|$)", "(^|\\/)\\.gnupg(\\/|$)", "(^|\\/)\\.netrc$",
  "(^|\\/)id_(rsa|dsa|ecdsa|ed25519)",
  // Package, cluster, registry and agent CLI credentials.
  "(^|\\/)\\.git-credentials$", "(^|\\/)\\.npmrc$", "(^|\\/)\\.pypirc$", "(^|\\/)\\.kube(\\/|$)", "(^|\\/)\\.docker(\\/|$)",
  "(^|\\/)gh\\/hosts\\.yml$", "(^|\\/)\\.codex\\/auth\\.json$", "(^|\\/)\\.claude\\/\\.credentials\\.json$"
].join("|"), "i");

export async function checkReadOnlyBash(command: string, ctx: ReadOnlyContext): Promise<FastPathVerdict> {
  if (command.length > (ctx.maxLength ?? DEFAULT_MAX_LENGTH)) return review("length");
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(command)) return review("control-char");
  if (!path.isAbsolute(ctx.cwd)) return review("cwd");
  const start = path.resolve(ctx.cwd);
  const outcome = await withBashTree(command, (tree): Outcome => (tree.hasError ? review("parse-error") : new Reader(ctx).sequence(tree.root, [start])));
  if (outcome === null) return review("parser-unavailable");
  return isReview(outcome) ? outcome : SKIP;
}

/** The pipeline stage the grammar hung a list on (see Reader.pipeline):
 *  reached inside that list, it runs the whole pipeline from there. */
interface Tail {
  id: number;
  run: (cwds: readonly string[]) => Outcome;
}

/** What a program's check may ask about where it runs. */
interface Site {
  /** git started from every possible cwd reads a registered repository. */
  inRegisteredRepo(): boolean;
}

class Reader {
  constructor(private readonly ctx: ReadOnlyContext) {}

  /** Statements one after another (`;`, a newline). */
  sequence(node: Node, cwds: readonly string[]): Outcome {
    let at: Cwds = unchanged(cwds);
    for (const child of node.children) {
      if (!child) continue;
      if (!child.isNamed) {
        if (child.type !== ";" && child.type !== "\n") return review(`operator:${child.type}`);
        continue;
      }
      const outcome = this.statement(child, union(at.ok, at.failed), null);
      if (isReview(outcome)) return outcome;
      at = outcome;
    }
    return at;
  }

  private statement(node: Node, cwds: readonly string[], tail: Tail | null): Outcome {
    if (tail && node.id === tail.id) return tail.run(cwds);
    switch (node.type) {
      case "comment": return unchanged(cwds);
      case "list": return this.list(node, cwds, tail);
      case "pipeline": return this.pipeline(node, cwds);
      case "negated_command": {
        const inner = named(node);
        if (inner.length !== 1) return review("node:negated_command");
        const outcome = this.statement(inner[0]!, cwds, null);
        return isReview(outcome) ? outcome : { ok: outcome.failed, failed: outcome.ok };
      }
      case "redirected_statement": return this.redirected(node, cwds, null, false);
      case "command": return this.command(node, cwds, false);
      default: return review(`node:${node.type}`);
    }
  }

  /** `a && b`, `a || b`: the grammar nests them to the left, two at a time. */
  private list(node: Node, cwds: readonly string[], tail: Tail | null): Outcome {
    let at: Cwds | null = null;
    let op: string | null = null;
    for (const child of node.children) {
      if (!child) continue;
      if (!child.isNamed) {
        if ((child.type !== "&&" && child.type !== "||") || at === null || op !== null) return review(`operator:${child.type}`);
        op = child.type;
        continue;
      }
      if (at === null) {
        const first = this.statement(child, cwds, tail);
        if (isReview(first)) return first;
        at = first;
        continue;
      }
      if (op === null) return review("node:list");
      const next = this.statement(child, op === "&&" ? at.ok : at.failed, tail);
      if (isReview(next)) return next;
      at = op === "&&" ? { ok: next.ok, failed: union(at.failed, next.failed) } : { ok: union(at.ok, next.ok), failed: next.failed };
      op = null;
    }
    return at && op === null ? at : review("node:list");
  }

  /** A pipeline's stages run in subshells: a cd there moves nothing after it,
   *  and is refused. The grammar reads `a && b 2>&1 | c` as a pipeline whose
   *  first stage is the list `a && b` carrying the redirect
   *  (tree-sitter-bash #345); bash runs it as `a && (b 2>&1 | c)`, and it is
   *  read that way. */
  private pipeline(node: Node, cwds: readonly string[]): Outcome {
    const first = named(node)[0];
    const body = first?.type === "redirected_statement" ? first.childForFieldName("body") : null;
    if (!first || !body || body.type !== "list") return this.stages(node, cwds, null);
    const tail = named(body).at(-1);
    if (!tail) return review("node:list");
    const firstId = first.id;
    return this.list(body, cwds, { id: tail.id, run: (at) => this.stages(node, at, { firstId, tail }) });
  }

  private stages(node: Node, cwds: readonly string[], split: { firstId: number; tail: Node } | null): Outcome {
    for (const child of node.children) {
      if (!child) continue;
      if (!child.isNamed) {
        if (child.type !== "|") return review(`operator:${child.type}`);
        continue;
      }
      // Nodes are new objects on every access: compare them by id.
      const outcome = split && child.id === split.firstId ? this.redirected(child, cwds, split.tail, true)
        : child.type === "command" ? this.command(child, cwds, true)
          : child.type === "redirected_statement" ? this.redirected(child, cwds, null, true)
            : review(`node:${child.type}`);
      if (isReview(outcome)) return outcome;
    }
    return unchanged(cwds);
  }

  /** Only redirects that write nothing: to /dev/null, or stdout and stderr
   *  into each other. Every write is the review's. */
  private redirected(node: Node, cwds: readonly string[], bodyOverride: Node | null, inPipeline: boolean): Outcome {
    const body = bodyOverride ?? node.childForFieldName("body");
    if (!body) return review("node:redirected_statement");
    for (const redirect of node.childrenForFieldName("redirect")) {
      if (!redirect) continue;
      if (redirect.type !== "file_redirect") return review(`node:${redirect.type}`);
      const op = redirect.children.find((c) => c && !c.isNamed)?.type ?? "";
      const descriptor = redirect.children.find((c) => c?.type === "file_descriptor")?.text ?? null;
      if (descriptor !== null && descriptor !== "1" && descriptor !== "2") return review(`redirect:${descriptor}`);
      // The grammar hangs the words after a redirect's target on it as more
      // targets (`>/dev/null $(touch x)`); bash runs them as arguments.
      const destinations = redirect.childrenForFieldName("destination").filter((c): c is Node => c !== null);
      if (destinations.length !== 1) return review("redirect");
      const destination = destinations[0]!;
      if (op === ">&") {
        if (destination.type !== "number" || (destination.text !== "1" && destination.text !== "2")) return review("redirect:>&");
        continue;
      }
      if (![">", ">>", "&>", "&>>"].includes(op)) return review(`redirect:${op}`);
      if (literal(destination, false) !== "/dev/null") return review("write");
    }
    if (body.type === "command") return this.command(body, cwds, inPipeline);
    return inPipeline ? review(`node:${body.type}`) : this.statement(body, cwds, null);
  }

  private command(node: Node, cwds: readonly string[], inPipeline: boolean): Outcome {
    let name: string | null = null;
    const args: string[] = [];
    for (const child of node.children) {
      if (!child) continue;
      // A word the grammar leaves unnamed (`==` as an argument) is still one
      // bash passes on: unread, it would shift every value after it.
      if (!child.isNamed) return review("word");
      if (child.type === "variable_assignment") return review("assignment");
      if (child.type === "command_name") {
        const word = child.namedChildren[0];
        if (!word || word.type !== "word" || UNQUOTED_SPECIAL.test(word.text)) return review("program-name");
        name = word.text;
        continue;
      }
      if (child.type === "file_redirect" || child.type === "heredoc_redirect" || child.type === "herestring_redirect") return review(`node:${child.type}`);
      const globOk = name !== null && GLOB_OK.has(name);
      const value = literal(child, globOk);
      if (value === null) return review(child.type === "word" ? "word" : "expansion");
      args.push(value);
    }
    if (name === null) return review("program-name");
    if (name.includes("/")) return review("path-program");
    if (args.some(namesSecret)) return review("secret-path");
    // Read from inside a credential folder, a plain name is a credential too.
    // Read from inside a credential folder, a plain name is a credential too;
    // a file the caller names secret counts by its path, from where the line stands.
    if (args.some((arg) => argParts(arg).some((part) => cwds.some((cwd) => {
      const resolved = path.resolve(cwd, part);
      return SECRET_PATH.test(resolved) || this.isSecretFile(resolved);
    })))) return review("secret-path");
    if (name === "cd") {
      const target = args[0];
      if (inPipeline || args.length !== 1 || !target || target === "-" || target.startsWith("-")) return review("cd");
      // bash's cd takes `..` by the words, as path.resolve does.
      return { ok: cwds.map((cwd) => path.resolve(cwd, target)), failed: cwds };
    }
    const program = own(PROGRAMS, name);
    if (!program) return review(`program:${name}`);
    this.ctx.onCommand?.([name, ...args]);
    const verdict = program(args, { inRegisteredRepo: () => cwds.every((cwd) => this.repoAt(cwd)) });
    return verdict.skip ? unchanged(cwds) : verdict;
  }

  /** A file the caller named secret, by its path: as written or where it
   *  lands. A pattern or another spelling that meets it is the file
   *  system's, as what a search finds is. */
  private isSecretFile(target: string): boolean {
    const secrets = this.ctx.secretFiles ?? [];
    if (secrets.length === 0) return false;
    const real = realOrNull(target);
    return secrets.some((file) => {
      const resolved = path.resolve(file);
      return target === resolved || (real !== null && real === realOrNull(resolved));
    });
  }

  /** git started here reads a registered repository: the nearest one up from
   *  here is registered, with no checkout or bare repository between (one
   *  checked in with the project's files, say), and the registered folder is
   *  a checkout, or git would look above it. */
  private repoAt(cwd: string): boolean {
    const real = realOrNull(cwd);
    if (!real) return false;
    let root: string | null = null;
    for (const repo of this.ctx.registeredRepos) {
      const candidate = realOrNull(repo);
      if (candidate && insideOrEqual(real, candidate) && (!root || candidate.length > root.length)) root = candidate;
    }
    if (!root || !fs.existsSync(path.join(root, ".git"))) return false;
    for (let dir = real; dir !== root; dir = path.dirname(dir)) {
      if (isRepository(dir) || path.dirname(dir) === dir) return false;
    }
    return true;
  }
}

function named(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

/** A word's value when it is literal: a plain word with nothing bash would
 *  expand (a glob only where `globOk`), a single-quoted string, a
 *  double-quoted one holding only text and no backslash, or a concatenation
 *  of those. Null otherwise. */
function literal(node: Node, globOk: boolean): string | null {
  switch (node.type) {
    case "word":
    case "number": {
      const text = node.text;
      if (!UNQUOTED_SPECIAL.test(text)) return text;
      return globOk && GLOB_ONLY.test(text) ? text : null;
    }
    case "raw_string": return node.text.slice(1, -1);
    case "string": {
      // Every child between the quotes is text: an unnamed one (a lone `$`)
      // is something the joined text would drop.
      const inner = node.children.slice(1, -1);
      if (inner.some((part) => !part || part.type !== "string_content")) return null;
      const text = inner.map((part) => part!.text).join("");
      return text.includes("\\") ? null : text;
    }
    case "concatenation": {
      let text = "";
      for (const part of node.children) {
        if (!part?.isNamed) return null;
        const value = literal(part, false);
        if (value === null) return null;
        text += value;
      }
      return text;
    }
    default: return null;
  }
}

/** The secret names a pattern is tried against: the files SECRET_PATH
 *  stands for, under the names they go by. A pattern that takes one of them
 *  and none of ORDINARY_NAMES names a secret (`*env`, `[.]env`, `id_*`); one
 *  that takes ordinary names too (`*`, `**`) is a search's own reach. */
const SECRET_NAMES = [
  ".env", ".env.local", ".env.development", ".env.production", ".env.staging", ".env.test", ".env.dev", ".env.prod",
  ".env-production", ".envrc", ".netrc", ".ssh", ".aws", ".gnupg", "environ",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk",
  ".git-credentials", ".npmrc", ".pypirc", ".kube", ".docker", "auth.json", ".credentials.json", "hosts.yml"
];
const ORDINARY_NAMES = ["README.md", "a", "index.ts", "package.json", "config.yml"];
/** What makes an argument a pattern to bash, git pathspecs or rg globs. */
const PATTERN_CHARS = /[*?[{]/;
/** POSIX classes as ranges, over the characters names here hold (letters,
 *  digits, `.`, `_`, `-`): Bun.Glob does not read `[:alpha:]`, and git, bash
 *  and grep do; nor equivalence classes (`[=e=]`) and collating elements
 *  (`[.e.]`), read as their one character. */
const POSIX_CLASSES: Record<string, string> = {
  alpha: "a-zA-Z", alnum: "a-zA-Z0-9", digit: "0-9", upper: "A-Z", lower: "a-z", xdigit: "0-9a-fA-F",
  punct: "._-", graph: "a-zA-Z0-9._-", print: "a-zA-Z0-9._-", space: " ", blank: " ", cntrl: " "
};

/** An argument names a secret: a word in it is a secret path (a flag's value
 *  too: `--x=v`, `-xv`, `rev:path`; with a tool's escapes read, `\.env`), or
 *  a pattern in it, as bash, git pathspecs or rg globs take it, picks out a
 *  secret's name. A leading `!` is an exclusion to rg and a name to bash, so
 *  what follows it is read either way. */
function namesSecret(arg: string): boolean {
  return argParts(arg).flatMap((part) => [part, part.replace(/\\(.)/g, "$1")])
    .some((part) => SECRET_PATH.test(part) || patternNamesSecret(part.startsWith("!") ? part.slice(1) : part));
}

/** Each segment of a pattern is one name in a path (`src/.en*`); a brace
 *  alternative holding a `/` is not split that way, so it is not read. Case
 *  aside: rg's --iglob and macOS's file system ignore it. */
/** A pattern as Bun.Glob reads it: POSIX classes as the ranges they hold,
 *  equivalence classes and collating elements as their one character.
 *  Null when it holds one this cannot read (it may match anything). */
function globSource(pattern: string): string | null {
  let unknownClass = false;
  const plain = pattern
    .replace(/\[:([a-z]+):\]/g, (_, name: string) => own(POSIX_CLASSES, name) ?? ((unknownClass = true), ""))
    .replace(/\[([=.])(.+?)\1\]/g, (_, __, element: string) => (element.length === 1 ? element : ((unknownClass = true), "")));
  return unknownClass ? null : plain;
}

function patternNamesSecret(text: string): boolean {
  if (!PATTERN_CHARS.test(text)) return false;
  if (/\{[^}]*\//.test(text)) return true;
  return text.split("/").some((segment) => {
    // A plain name beside the pattern (`*/credentials`) is one it selects.
    if (!PATTERN_CHARS.test(segment)) return SECRET_NAMES.some((name) => name.toLowerCase() === segment.toLowerCase());
    const plain = globSource(segment);
    if (plain === null) return true;
    let globs: Array<{ match(path: string): boolean }>;
    try {
      globs = [new Bun.Glob(plain), new Bun.Glob(plain.toLowerCase())];
    } catch {
      return true;
    }
    const takes = (name: string) => globs.some((glob) => glob.match(name));
    return SECRET_NAMES.some(takes) && !ORDINARY_NAMES.some(takes);
  });
}

/** An argument and every value it may carry: after `=` or `:` (`--x=v`,
 *  `rev:path`), and each tail of a short-flag cluster (`-xv`). */
function argParts(arg: string): string[] {
  const parts = new Set([arg]);
  for (let i = 0; i < arg.length; i++) {
    if (arg[i] === "=" || arg[i] === ":") parts.add(arg.slice(i + 1));
  }
  if (/^-[^-]/.test(arg)) {
    for (let i = 2; i < arg.length; i++) parts.add(arg.slice(i));
  }
  parts.delete("");
  return [...parts];
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function insideOrEqual(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** What git takes for a repository when it looks for one here: a `.git`,
 *  or the shape of a bare one (HEAD with objects or refs). */
function isRepository(dir: string): boolean {
  const has = (name: string) => fs.existsSync(path.join(dir, name));
  return has(".git") || (has("HEAD") && (has("objects") || has("refs")));
}

// ── Flags ──────────────────────────────────────────────────────────────────
//
// A table never takes the next argument for a value unless the program
// surely does: an argument read as a flag or an operand is checked, while one
// taken for a value is not, so a wrong guess either way must fall on the
// checked side.

interface FlagSpec {
  /** Short flags that take no value, as one string ("rnil"). */
  short?: string;
  /** Short flags whose value is required: attached, or the next argument. */
  shortValue?: string;
  /** Short flags whose value, if any, is attached (`-U3`). */
  shortOptional?: string;
  long?: readonly string[];
  /** Long flags whose value is required: `--x=v` or `--x v`. */
  longValue?: readonly string[];
  /** Long flags whose value, if any, is `--x=v` (git's `--color`, `--stat`). */
  longOptional?: readonly string[];
  /** `-5` style counts (git log). */
  numeric?: boolean;
  /** Every flag is accepted (tools with no flag that runs, writes or fetches). */
  anyFlag?: boolean;
}

interface Parsed {
  flags: string[];
  operands: string[];
  /** A flag came after an operand: GNU and getopt_long tools read it as a
   *  flag, BSD getopt tools (macOS's uniq) and POSIX mode as an operand. */
  mixed: boolean;
}

/** Splits arguments by a flag table, or names the first argument it does
 *  not allow. Long flags must match exactly: git and GNU tools accept any
 *  unambiguous abbreviation, which a table of full names would let through. */
function parseFlags(args: readonly string[], spec: FlagSpec): Parsed | string {
  const flags: string[] = [];
  const operands: string[] = [];
  let mixed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      // After an operand, a getopt that stops there takes `--` for one.
      if (operands.length > 0) mixed = true;
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    if (operands.length > 0) mixed = true;
    if (spec.anyFlag) {
      flags.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const [flag, value] = splitOnce(arg, "=");
      if (spec.longOptional?.includes(flag)) {
        flags.push(flag);
        continue;
      }
      if (value === null && spec.long?.includes(flag)) {
        flags.push(flag);
        continue;
      }
      if (spec.longValue?.includes(flag)) {
        if (value === null) {
          if (i + 1 >= args.length) return arg;
          i++;
        }
        flags.push(flag);
        continue;
      }
      return arg;
    }
    if (spec.numeric && /^-\d+$/.test(arg)) {
      flags.push(arg);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const c = arg[j]!;
      if (spec.short?.includes(c)) {
        flags.push(`-${c}`);
        continue;
      }
      if (spec.shortOptional?.includes(c)) {
        flags.push(`-${c}`);
        break;
      }
      if (spec.shortValue?.includes(c)) {
        if (j === arg.length - 1) {
          if (i + 1 >= args.length) return arg;
          i++;
        }
        flags.push(`-${c}`);
        break;
      }
      return arg;
    }
  }
  return { flags, operands, mixed };
}

function splitOnce(text: string, sep: string): [string, string | null] {
  const at = text.indexOf(sep);
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + sep.length)];
}

type Program = (args: string[], site: Site) => FastPathVerdict;

const flagged = (name: string, spec: FlagSpec, more?: (parsed: Parsed) => FastPathVerdict): Program => (args) => {
  const parsed = parseFlags(args, spec);
  if (typeof parsed === "string") return review(`flag:${name} ${parsed}`);
  return more ? more(parsed) : SKIP;
};

const ANY: FlagSpec = { anyFlag: true };

const GREP: FlagSpec = {
  short: "rRnilLcvwxEFPohHsqzaUI",
  shortValue: "ABCmef",
  long: ["--recursive", "--dereference-recursive", "--line-number", "--ignore-case", "--files-with-matches", "--files-without-match",
    "--count", "--invert-match", "--word-regexp", "--line-regexp", "--extended-regexp", "--fixed-strings", "--perl-regexp",
    "--only-matching", "--no-filename", "--with-filename", "--no-messages", "--quiet", "--silent", "--null", "--text", "--binary"],
  longValue: ["--include", "--exclude", "--exclude-dir", "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context"],
  longOptional: ["--color", "--colour"]
};

/** rg, without what runs a program (`--pre`, `-z` decompressors) or writes.
 *  `-r` replaces what it prints and nothing else. */
const RG: FlagSpec = {
  short: "nilcvwFoNSsxHIpUuL.",
  shortValue: "egrtTABCmMjf",
  long: ["--hidden", "--no-ignore", "--unrestricted", "--follow", "--files", "--files-with-matches", "--files-without-match", "--count",
    "--count-matches", "--invert-match", "--word-regexp", "--fixed-strings", "--only-matching", "--line-number", "--no-line-number",
    "--no-heading", "--heading", "--column", "--json", "--smart-case", "--case-sensitive", "--ignore-case", "--multiline", "--vimgrep",
    "--no-filename", "--with-filename", "--null", "--stats", "--quiet", "--pretty", "--no-messages", "--trim"],
  longValue: ["--glob", "--iglob", "--type", "--type-not", "--max-count", "--max-depth", "--max-columns", "--after-context",
    "--before-context", "--context", "--sort", "--sortr", "--color", "--regexp", "--threads", "--max-filesize", "--file", "--replace"]
};

/** sort, without `-o` and the buffer size (a small one makes BSD sort write
 *  temporary files). */
const SORT: FlagSpec = {
  short: "nruhVfbsgMcC",
  shortValue: "kt",
  long: ["--numeric-sort", "--reverse", "--unique", "--human-numeric-sort", "--version-sort", "--ignore-case", "--stable",
    "--general-numeric-sort", "--month-sort", "--ignore-leading-blanks", "--check"],
  longValue: ["--key", "--field-separator"]
};

/** find: paths, then only these predicates (with how many values each takes). */
const FIND_PREDICATES: Record<string, number> = {
  "-name": 1, "-iname": 1, "-path": 1, "-ipath": 1, "-type": 1, "-maxdepth": 1, "-mindepth": 1, "-newer": 1, "-mtime": 1,
  "-mmin": 1, "-size": 1, "-empty": 0, "-print": 0, "-print0": 0, "-prune": 0, "-not": 0, "!": 0, "-o": 0, "-a": 0, "-or": 0,
  "-and": 0, "(": 0, ")": 0
};

function find(args: string[]): FastPathVerdict {
  let i = 0;
  while (i < args.length && !args[i]!.startsWith("-") && args[i] !== "!" && args[i] !== "(") i++;
  while (i < args.length) {
    const arity = own(FIND_PREDICATES, args[i]!);
    if (arity === undefined) return review(`flag:find ${args[i]}`);
    i += 1 + arity;
  }
  return i === args.length ? SKIP : review("flag:find");
}

/** sed only as a line printer: `-n` and `N p`, `M,N p` or `$p`, at most one file. */
function sed(args: string[]): FastPathVerdict {
  if (args.length < 2 || args.length > 3 || args[0] !== "-n") return review("flag:sed");
  if (!/^(\d+|\$)(,(\d+|\$))?p$/.test(args[1]!)) return review("flag:sed script");
  if (args[2]?.startsWith("-")) return review(`flag:sed ${args[2]}`);
  return SKIP;
}

function jq(args: string[]): FastPathVerdict {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--arg" || arg === "--argjson") {
      i += 2;
      continue;
    }
    if (/^-[rcesnSaj]+$/.test(arg) || ["--raw-output", "--compact-output", "--exit-status", "--slurp", "--null-input", "--sort-keys", "--join-output", "--tab"].includes(arg)) continue;
    if (arg.startsWith("-")) return review(`flag:jq ${arg}`);
    operands.push(arg);
  }
  const filter = operands[0] ?? "";
  if (/\benv\b|\$ENV|\binclude\b|\bimport\b|\binput_filename\b|\$__loc__/.test(filter)) return review("flag:jq filter");
  return SKIP;
}

/** printf, but not `-v` (assigns a variable) nor a `%n` conversion (bash's
 *  stores a count into the variable its argument names). */
function printf(args: string[]): FastPathVerdict {
  const format = args[0] ?? "";
  if (format.startsWith("-")) return review(`flag:printf ${format}`);
  return /%[-+ #0'*.\d]*[hjlLtz]*n/.test(format.replaceAll("%%", "")) ? review("flag:printf %n") : SKIP;
}

function date(args: string[]): FastPathVerdict {
  for (const arg of args) {
    if (arg.startsWith("+") || arg === "-u" || arg === "-R" || arg === "-I" || /^--iso-8601(=\w+)?$/.test(arg) || arg === "--utc") continue;
    return review(`flag:date ${arg}`);
  }
  return SKIP;
}

/** Flags of ps that take a value, with a dash or without, on both macOS and
 *  procps: what follows one is a pid, a user or a format. */
const PS_VALUE = "OoptU";

/** ps, except what prints other processes' environments: `E`, and `e` but in
 *  the dashed clusters every ps reads as "all processes" (`-e`, `-ef`, `-eo`):
 *  without a dash `e` means the environment, and procps rereads a dashed
 *  cluster it cannot parse (`-auxe`) that way. */
/** SysV flags procps reads without a value: with `e` only these may appear,
 *  for any other (`-x`) sends procps back over the whole line BSD style,
 *  where `e` is the environment. */
const PS_SYSV = "AadeflwFHjLMNyc";
/** Format fields both macOS and procps print: with `e`, a format may hold
 *  only these, since one procps does not know sends it back BSD style too. */
const PS_FIELDS = new Set(["pid", "ppid", "pgid", "sid", "uid", "user", "comm", "command", "args", "cmd", "stat", "state", "etime",
  "time", "%cpu", "%mem", "pcpu", "pmem", "rss", "vsz", "tty", "tt", "lstart", "start", "nice", "pri", "wchan", "ucomm"]);

function ps(args: string[]): FastPathVerdict {
  let dashedE = false;
  let allSysV = true;
  /** Every value is one procps takes as SysV: a known format, or pids. */
  let valuesSysV = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (arg === "--no-headers" || arg === "--forest") continue;
      return review(`flag:ps ${arg}`);
    }
    const dashed = arg.startsWith("-");
    const letters = dashed ? arg.slice(1) : arg;
    // The flags end at the first that takes a value; what follows it in the
    // cluster is that value (`-ocommand,stat`), else the next argument is.
    const valueAt = [...letters].findIndex((c) => PS_VALUE.includes(c));
    const flags = valueAt < 0 ? letters : letters.slice(0, valueAt + 1);
    if (flags.includes("E") || (flags.includes("e") && !(dashed && /^[eflwFHj]*o?$/.test(flags)))) return review(`flag:ps ${arg}`);
    if (dashed && flags.includes("e")) dashedE = true;
    if (!dashed || [...(valueAt < 0 ? flags : flags.slice(0, -1))].some((c) => !PS_SYSV.includes(c))) allSysV = false;
    if (valueAt < 0) continue;
    const value = valueAt < letters.length - 1 ? letters.slice(valueAt + 1) : args[++i];
    if (value === undefined) {
      valuesSysV = false;
      continue;
    }
    const fields = value.split(/[,\s]+/).filter(Boolean).map((field) => field.split("=")[0]!);
    if (letters[valueAt] === "o" ? !fields.every((field) => PS_FIELDS.has(field)) : !(letters[valueAt] === "p" && /^\d+(,\d+)*$/.test(value))) valuesSysV = false;
    // A format's fields, each maybe renamed (`pid=PID`): procps's `environ`
    // prints environments.
    if ("oO".includes(letters[valueAt]!) && fields.some((field) => /env/i.test(field))) return review(`flag:ps ${value}`);
  }
  return dashedE && !(allSysV && valuesSysV) ? review("flag:ps e") : SKIP;
}

/** file, without the flags that compile magic (`-C` writes `.mgc` files),
 *  read another magic or list file, or run decompressors. */
const FILE: FlagSpec = {
  short: "bhiLkN",
  long: ["--brief", "--mime", "--mime-type", "--mime-encoding", "--dereference", "--no-dereference", "--keep-going", "--no-pad"]
};

/** uniq: a second operand is the file it writes, and macOS's uniq takes
 *  anything after the first operand for one (`uniq in -c` writes `-c`). */
const UNIQ = flagged("uniq", {
  short: "cdDuiz",
  shortValue: "fsw",
  long: ["--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated"],
  longValue: ["--skip-fields", "--skip-chars", "--check-chars"],
  longOptional: ["--all-repeated", "--group"]
}, (parsed) => (parsed.operands.length > 1 || parsed.mixed ? review("flag:uniq output") : SKIP));

const DIFF: FlagSpec = {
  short: "uqwbBiyaNtTpcs",
  shortOptional: "UC",
  long: ["--brief", "--side-by-side", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines", "--ignore-case",
    "--strip-trailing-cr", "--text", "--report-identical-files", "--minimal", "--suppress-common-lines", "--expand-tabs",
    "--initial-tab", "--show-c-function", "--new-file", "--normal"],
  longOptional: ["--unified", "--context", "--color", "--label", "--width"]
};

/** wc and du, but not `--files0-from` (a list of files to read, whose bad
 *  names come back in errors) nor an abbreviation of it. */
const noFileList = (name: string): Program => (args) => {
  const bad = args.find((arg) => arg.startsWith("--f"));
  return bad ? review(`flag:${name} ${bad}`) : SKIP;
};

/** set, only to turn on errexit, nounset or pipefail: bare, it prints every
 *  variable, credentials in the environment among them; `-x` expands PS4. */
function setFlags(args: string[]): FastPathVerdict {
  if (args.length === 0) return review("flag:set");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^[-+][eu]*o?$/.test(arg) && arg.length > 1) {
      if (arg.endsWith("o")) {
        if (!["pipefail", "errexit", "nounset"].includes(args[i + 1] ?? "")) return review("flag:set");
        i++;
      }
      continue;
    }
    return review(`flag:set ${arg}`);
  }
  return SKIP;
}

/** tmux reads: each command's flags as its getopt string has them (values
 *  required), and whether it prints only with `-p`. */
const TMUX_READS: Record<string, { flags: string; values: string; print?: boolean }> = {
  "list-sessions": { flags: "r", values: "FfO" },
  ls: { flags: "r", values: "FfO" },
  "list-windows": { flags: "ar", values: "FfOt" },
  lsw: { flags: "ar", values: "FfOt" },
  "list-panes": { flags: "ars", values: "FfOt" },
  lsp: { flags: "ars", values: "FfOt" },
  "show-options": { flags: "AgHpqsvw", values: "t" },
  show: { flags: "AgHpqsvw", values: "t" },
  "display-message": { flags: "alNpv", values: "cdtF", print: true },
  display: { flags: "alNpv", values: "cdtF", print: true },
  "capture-pane": { flags: "aCeJMNpPqT", values: "ESt", print: true },
  capturep: { flags: "aCeJMNpPqT", values: "ESt", print: true }
};

/** A tmux argument tmux reads only as text: no `;` (which ends a command, at
 *  an argument's end too) and no format but a plain variable (`#S`,
 *  `#{pane_id}`): `#()` runs a shell command, and `E:` or `T:` expand an
 *  option's value, which may hold one. */
function tmuxText(arg: string): boolean {
  return !arg.includes(";") && !arg.replace(/##|#\{[a-z0-9_]+\}|#[A-Za-z]/g, "").includes("#");
}

function tmux(args: string[]): FastPathVerdict {
  const [sub, ...rest] = args;
  const read = sub ? own(TMUX_READS, sub) : undefined;
  if (!read) return review(`flag:tmux ${sub ?? ""}`);
  if (!rest.every(tmuxText)) return review(`flag:tmux ${sub}`);
  let printing = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--" || !arg.startsWith("-") || arg === "-") break;
    for (let j = 1; j < arg.length; j++) {
      const c = arg[j]!;
      if (read.flags.includes(c)) {
        if (c === "p") printing = true;
        continue;
      }
      if (!read.values.includes(c)) return review(`flag:tmux ${sub} -${c}`);
      if (j === arg.length - 1) {
        if (i + 1 >= rest.length) return review(`flag:tmux ${sub} -${c}`);
        i++;
      }
      break;
    }
  }
  return read.print && !printing ? review(`flag:tmux ${sub} without -p`) : SKIP;
}

// git: read subcommands with their flags; only inside a registered repository.
// A value git takes from the next argument only where that was seen to be so
// (git 2.50): `--format`, `--pretty`, `--stat`, `--color`, `--abbrev`,
// `--decorate`, `--relative`, `--word-diff`, `--unified` and `-U` leave it.
const REVISION_VALUES = ["--max-count", "--since", "--after", "--until", "--before", "--author", "--committer", "--grep", "--date", "--skip"];
const LOG_FLAGS: FlagSpec = {
  short: "p",
  shortValue: "nSG",
  numeric: true,
  long: ["--oneline", "--shortstat", "--numstat", "--name-only", "--name-status", "--graph", "--all", "--reverse", "--merges", "--no-merges",
    "--first-parent", "--abbrev-commit", "--follow", "--patch", "--no-patch", "--raw", "--cherry-pick", "--left-right", "--no-color",
    "--source", "--topo-order", "--date-order", "--full-history", "--summary", "--no-decorate", "--boundary"],
  longValue: [...REVISION_VALUES, "--diff-filter"],
  longOptional: ["--format", "--pretty", "--decorate", "--abbrev", "--color", "--stat"]
};
const GIT: Record<string, FlagSpec & { listOnly?: string[] }> = {
  status: {
    short: "sbuzv",
    long: ["--short", "--branch", "--no-renames", "--long", "--verbose", "--show-stash", "--ahead-behind", "--no-ahead-behind"],
    longOptional: ["--porcelain", "--untracked-files", "--ignored"]
  },
  log: LOG_FLAGS,
  show: { ...LOG_FLAGS, short: "ps" },
  diff: {
    short: "wbR",
    shortOptional: "U",
    long: ["--numstat", "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--no-color", "--ignore-all-space",
      "--ignore-space-change", "--patch", "--raw", "--summary", "--no-renames", "--exit-code", "--quiet", "--minimal"],
    longValue: ["--diff-filter"],
    longOptional: ["--unified", "--word-diff", "--color", "--stat", "--relative"]
  },
  blame: { short: "wsefnlct", shortValue: "L", long: ["--porcelain", "--line-porcelain", "--show-email", "--show-name", "--root"], longOptional: ["--date"] },
  grep: {
    short: "nilcvwEFPhHIqoz",
    shortValue: "eABCm",
    long: ["--cached", "--untracked", "--line-number", "--ignore-case", "--files-with-matches", "--count", "--invert-match", "--word-regexp",
      "--extended-regexp", "--fixed-strings", "--perl-regexp", "--only-matching", "--quiet"],
    longOptional: ["--max-depth", "--max-count", "--after-context", "--before-context", "--context"]
  },
  "rev-parse": {
    short: "q",
    long: ["--show-toplevel", "--git-dir", "--is-inside-work-tree", "--verify", "--symbolic-full-name", "--show-prefix", "--show-cdup",
      "--absolute-git-dir", "--git-common-dir", "--is-bare-repository", "--quiet"],
    longOptional: ["--short", "--abbrev-ref"]
  },
  "ls-files": {
    short: "cdmoisukz",
    long: ["--others", "--exclude-standard", "--cached", "--deleted", "--modified", "--stage", "--full-name", "--error-unmatch", "--directory", "--no-empty-directory", "--ignored"],
    longOptional: ["--exclude", "--format"]
  },
  "ls-tree": { short: "rdtlz", long: ["--name-only", "--name-status", "--full-name", "--full-tree", "--long"], longOptional: ["--format", "--abbrev"] },
  "cat-file": { short: "tsep" },
  "merge-base": { long: ["--is-ancestor", "--all", "--fork-point", "--octopus", "--independent"] },
  describe: { long: ["--tags", "--always", "--long", "--exact-match", "--all", "--contains"], longOptional: ["--abbrev", "--match", "--exclude", "--candidates"] },
  "rev-list": { shortValue: "n", long: ["--count", "--all", "--left-right", "--merges", "--no-merges", "--first-parent", "--reverse", "--topo-order"], longValue: REVISION_VALUES },
  shortlog: { short: "sne", long: ["--summary", "--numbered", "--email", "--all", "--no-merges"], longValue: ["--since", "--until", "--after", "--before"], longOptional: ["--format"] },
  "for-each-ref": { longOptional: ["--format", "--sort", "--count", "--contains", "--merged", "--no-merged", "--points-at"] },
  branch: {
    short: "lavr",
    long: ["--list", "--show-current", "--all", "--remotes", "--verbose", "--no-color"],
    longOptional: ["--contains", "--merged", "--no-merged", "--sort", "--format", "--points-at"],
    listOnly: ["-l", "--list"]
  },
  tag: { short: "l", long: ["--list"], longOptional: ["--sort", "--contains", "--points-at", "--format", "--merged", "--no-merged"], listOnly: ["-l", "--list"] }
};

function git(args: string[], site: Site): FastPathVerdict {
  let i = 0;
  while (args[i]?.startsWith("-")) {
    if (args[i] !== "--no-pager") return review(`flag:git ${args[i]}`);
    i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return review("flag:git");
  let verdict: FastPathVerdict;
  if (sub === "remote") {
    verdict = rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || (rest[0] === "get-url" && rest.length <= 3) ? SKIP : review("flag:git remote");
  } else if (sub === "worktree" || sub === "stash") {
    verdict = rest[0] === "list" && rest.slice(1).every((arg) => arg === "--porcelain" || arg === "-v") ? SKIP : review(`flag:git ${sub}`);
  } else if (sub === "config") {
    const parsed = parseFlags(rest, {
      long: ["--global", "--local", "--system", "--worktree", "--null", "--show-origin", "--show-scope", "--get", "--get-all", "--get-regexp"],
      longOptional: ["--type", "--default"]
    });
    // git config stops reading options at the key: `key --get` sets the key.
    verdict = typeof parsed === "string" ? review(`flag:git config ${parsed}`)
      : parsed.mixed ? review("flag:git config after operand")
      : parsed.flags.some((flag) => flag === "--get" || flag === "--get-all" || flag === "--get-regexp") ? SKIP : review("flag:git config");
  } else {
    const spec = own(GIT, sub);
    if (!spec) return review(`flag:git ${sub}`);
    const parsed = parseFlags(rest, spec);
    if (typeof parsed === "string") return review(`flag:git ${sub} ${parsed}`);
    // A pathspec's magic (`:(literal).env`, `:(icase)…`, `:!…`) changes which
    // path it names, past what the secret check reads.
    if (parsed.operands.some((operand) => operand.startsWith(":"))) return review(`flag:git ${sub} pathspec`);
    if (spec.listOnly) {
      const listing = parsed.flags.some((flag) => spec.listOnly!.includes(flag));
      if (sub === "tag" && !listing) return review("flag:git tag");
      if (parsed.operands.length > 0 && !listing) return review(`flag:git ${sub} operand`);
    }
    verdict = SKIP;
  }
  if (!verdict.skip) return verdict;
  return site.inRegisteredRepo() ? SKIP : review("git-repo");
}

const PROGRAMS: Record<string, Program> = {
  ...Object.fromEntries(
    ["cat", "head", "tail", "nl", "cut", "tr", "paste", "rev", "tac", "comm", "cmp", "stat", "df", "basename", "dirname", "realpath",
      "readlink", "ls", "pwd", "which", "uname", "id", "whoami", "sleep", "true", "false", "echo", "pgrep"]
      .map((name): [string, Program] => [name, flagged(name, ANY)])
  ),
  wc: noFileList("wc"),
  du: noFileList("du"),
  grep: flagged("grep", GREP),
  egrep: flagged("egrep", GREP),
  fgrep: flagged("fgrep", GREP),
  rg: flagged("rg", RG),
  sort: flagged("sort", SORT),
  find: (args) => find(args),
  sed: (args) => sed(args),
  jq: (args) => jq(args),
  printf: (args) => printf(args),
  date: (args) => date(args),
  ps: (args) => ps(args),
  file: flagged("file", FILE),
  uniq: UNIQ,
  diff: flagged("diff", DIFF),
  set: (args) => setFlags(args),
  tmux: (args) => tmux(args),
  git
};
