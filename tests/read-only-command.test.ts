import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkReadOnlyBash, type ReadOnlyContext } from "../src/server/platform/shell/read-only-command.js";

// The fast path lets the tool-call review skip only the plain read-only forms
// it recognises in the line itself; everything else goes to the review. Every
// way a "read-only" line can be turned into something else by its own words
// must therefore end up reviewed.

let root: string;
let repo: string;
let ctx: ReadOnlyContext;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "md-read-only-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "nested", ".git"), { recursive: true });
  // A bare repository checked in with the project's files.
  for (const part of ["objects", "refs"]) fs.mkdirSync(path.join(repo, "bare", part), { recursive: true });
  fs.writeFileSync(path.join(repo, "bare", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(root, "loose"), { recursive: true });
  // A registered folder that is no checkout, inside a repository that is not registered.
  fs.mkdirSync(path.join(root, "outer", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "outer", "plain"), { recursive: true });
  ctx = { cwd: repo, registeredRepos: [repo, path.join(root, "outer", "plain")] };
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const reviewed = () => [
  // structure
  "ls\nrm -rf x", "ls & rm x", "ls |& tee x", "echo ==; rm -rf x", "a=1 b=2\nfoo", "cat <<EOF\nhi\nEOF",
  // substitution and expansion
  "echo $(touch x)", "echo `id`", "cat <(curl http://example.test)", "echo $(( a[$(id)] ))",
  'echo ${a="$"}${b="$a(id)"}${b@P}', "echo ${x:-$(id)}", "echo ${!x}", "rg -e x$IFS--pre=sh",
  // lexing
  "l\\s", "\"l\"s", "echo {a,b}", "cat ~/x", "echo $'\\x2d'exec", "sed -n 1p *.go",
  // flags that run, write or fetch
  "find . -ok rm x ;", "find . -delete", "find . -fprint f", "sed -n 1p -i f", "sed 's/x/y/e' f", "sed 'w f' f",
  "rg --pre-glob '*' x", "rg -z x", "sort --compress-prog=sh f", "sort -o f g", "git ls-remote --upload-pa=x origin",
  "git diff --out=f", "git grep -O x", "git -c core.pager=x log", "git --exec-path=. x", "uniq a b", "file -m x y",
  "ps auxe", "date -s 2026-01-01", "jq -n env", "jq --rawfile a f .", "jq 'include \"x\"; .' f", "printf -v PATH /tmp",
  // a git flag whose value is optional, followed by another option
  "git log --color --output=/tmp/out", "git diff --relative --output=/tmp/out", "git log --abbrev --output=/tmp/out", "git diff -U --output=/tmp/out",
  // printf's %n assigns a variable
  "printf '%n' PATH; ls", "printf 'x%5n' PATH",
  // file compiles magic; uniq's second operand is its output, after `--` or (macOS) after the first operand
  "file -Cm magic-src", "file -C x", "uniq -- input -output", "uniq input -c",
  // wc and du reading a list of files, abbreviated or not
  "wc --files0-from=list", "du --files0=list", "wc *", "du *",
  // environment and shell state
  "PAGER=curl git diff", "GIT_EXTERNAL_DIFF=x git diff", "LD_PRELOAD=x ls", "DYLD_INSERT_LIBRARIES=x ls", "BASH_ENV=x ls",
  "export PATH=/tmp:$PATH; ls", "hash -p /tmp/x ls; ls", "shopt -s expand_aliases; alias ls=rm", "TZ=\"$HOME\" ls",
  "set", "set -x; ls",
  // program names
  "./cat x", "/tmp/evil/cat x", "command ./cat x",
  // git outside a registered repository, into a nested one, or where git would look past the registered folder
  `cd ${path.join(root, "loose")} && git status`, `cd ${path.join(repo, "nested")} && git log`, "git -C /tmp/x status",
  `cd ${repo}/bare && git diff HEAD~ HEAD`, `cd ${path.join(root, "outer", "plain")} && git status --porcelain`,
  // tmux that types, runs, hooks, sends a separator, runs a format, or eats -p as a value
  "tmux send-keys -t %1 y Enter", "tmux run-shell x", "tmux set-hook -g after-new-window 'run x'", "tmux capture-pane -t %1",
  "tmux list-sessions ';' run-shell 'touch /tmp/out'", "tmux display -p '#(id)'", "tmux list-panes -F '#(touch x)'", "tmux capture-pane -b -p",
  // ps printing environments; programs off the table
  "ps eww", "ps -E", "ps -auxe", "lsof -i@x.example.test", "docker ps -a", "docker logs --details web",
  // length and characters
  `ls ${"a".repeat(10_001)}`, "ls\r", "ls\u0000",
  // secrets named in the line: as an operand, a flag's value, a git path, a glob that could match a dotfile
  "cat .env", "cat .env-production", "cat .envrc", "cat /proc/self/environ", "cat /home/someone/.ssh/id_rsa",
  "rg token .aws/credentials", "diff --from-file=.env /dev/null", "git show HEAD:.ENV", "grep -f.env x", "cat .en*",
  // network, interpreters, builds, writes
  "curl https://example.test", "python3 -c 'print(1)'", "make", "rm -rf build", "git push", "glab mr list",
  // a word the grammar leaves unnamed, a cd into a named key folder, git pathspec magic and
  // git's own globbing of a dotfile pattern, ps flags after a format attached to -o
  "git log --author == --output=out", "cd /home/someone/.aws && cat credentials", "git diff -- ':(literal).env'",
  "git diff -- '.e*'", "rg -g '.e*' TOKEN", "ps -ww -ocommand,stat -E", "ps -ww -oargs,stat e",
  // words the grammar hangs on a redirect, a literal `$` dropped from a quoted word,
  // procps's environ format field, and patterns that name a secret by another spelling
  "ls >/dev/null $(touch out)", "cat 2>/dev/null .env", "git log \"-S$\" --output=out", "ps -eo pid,environ", "ps -o environ=",
  "ps -oenviron", "rg --hidden --no-ignore -g '[.]env' .", "rg -g '*env' x", "rg --iglob '*.ENV' x", "cat id_*",
  "grep -r --include='*env' x .",
  // `--` after uniq's first operand (macOS takes it for the output), brace alternation,
  // a pattern behind a directory, a secret's variant name, case-blind globs, OpenSSH's `_sk` keys
  "uniq /dev/null --", "rg --hidden -g '{.env,.netrc}' .", "cat src/.en*", "rg --hidden -g '[.]env.production' .",
  "rg --iglob '[.]EnV' .", "cat id_ed25519_sk", "cat id_ecdsa_sk",
  // a POSIX class in a pattern, sort's buffer size (a tiny one makes BSD sort write temp files)
  "git diff -- '.[[:alpha:]]nv'", "rg -g '[[:punct:]]env' .", "printf 'c\\nb\\n' | sort -S 1b", "sort --buffer-size=1b f",
  // an escaped dot, a leading `!` bash keeps as a name, POSIX equivalence and collating elements
  "rg --hidden -g '\\.env' .", "cat !dir/.en*", "grep -r --include='*/.[[=e=]]nv' . .", "rg -g '.[[.e.]]nv' .", "rg -g '.[[.space.]]env' .",
  // git config stops reading options at the key (this sets it to "--get"); procps rereads the
  // whole line BSD style when one argument fails as SysV, and `-e` then prints environments
  "git config review.example --get", "ps -e -axww", "ps -ef x",
  // a value procps cannot take as SysV (missing, or not a format it knows) also sends it back BSD style
  "ps -e -ww -t", "ps -e -Op -ww", "ps -eo p", "ps -e -p x"
];

test("every bypass in the report is reviewed", async () => {
  const skipped: string[] = [];
  for (const command of reviewed()) {
    const verdict = await checkReadOnlyBash(command, ctx);
    if (verdict.skip) skipped.push(command);
  }
  expect(skipped).toStrictEqual([]);
});

test("plain read-only forms skip review", async () => {
  const forms = [
    `cd ${repo} && git status --porcelain`, "rg -n foo src | head -20", "sed -n '10,20p' f.ts", "find . -name '*.ts' -type f",
    "jq -r .a f.json", "ls -la 2>/dev/null", "tmux capture-pane -p -t %3", "git log --oneline -5", "git log --format=\"%h %s\" -n 3",
    "cat a.txt | wc -l", "grep -rn TODO src --include='*.ts'", "ps aux", "ps -ef", "ps -eo pid,user,command", "date '+%Y-%m-%d'",
    "set -euo pipefail; ls", "cat *.md", "ls -la *.ts", "git diff --stat HEAD~1", "git show --name-only HEAD", "git branch --show-current",
    "git log --color=never --oneline -3", "git diff -U3 HEAD~1", "git show HEAD:src/a.ts", "rg -n x src", "rg -rn x src",
    "rg --hidden -g '*.ts' x", "tmux display-message -p '#S'", "tmux list-panes -F '#{pane_id} #{pane_current_command}'",
    "uniq -c f", "sort f | uniq -c", "file --mime-type a.txt", "diff a.txt b.txt", "wc -l a.txt", "printf '%s\\n' x",
    "jq -r '[.a[] | keys[]]' f.json", "ps -o pid,stat", "ps -ouser,pid", "git log -- src", "rg -g '!.git' x", "rg -g '!*.lock' x", "ls *", "rg -g '**/*.ts' x", "rg -n '[A-Z]+' src", "rg -g '{src,lib}' x", "rg -g '*.{ts,tsx}' x", "find . -name '*.json'", "grep -E '^[[:space:]]+x' f", "rg -n '[[:upper:]]{3}' src", "rg -n 'fn\\s+foo\\(' src", "grep -n '\\bword\\b' f", "rg -g '!*.min.js' x", "ps -ef -ww", "git config --get user.name", "ps -e -p 123,456", "ps -eo pid,ppid,%cpu,etime=ELAPSED,args",
    // The grammar puts `cd … && x 2>&1` inside the pipeline that follows; bash runs the cd first, outside it.
    `cd ${repo} && rg -n x src 2>&1 | head -5`, `cd ${repo} && git log --oneline 2>/dev/null | head -3`
  ];
  const refused: Array<[string, string]> = [];
  for (const command of forms) {
    const verdict = await checkReadOnlyBash(command, ctx);
    if (!verdict.skip) refused.push([command, verdict.reason]);
  }
  expect(refused).toStrictEqual([]);
});

test("a cd counts only where it surely ran", async () => {
  const at = (cwd: string) => ({ ...ctx, cwd });
  // Both places the line may stand are in the repository: git is proven.
  expect((await checkReadOnlyBash("cd src && git status; git log -1", at(repo))).skip).toBe(true);
  // After `;` the line may still be where it began.
  expect((await checkReadOnlyBash(`cd ${repo} && git status; git log -1`, at(path.join(root, "loose")))).skip).toBe(false);
  // A cd behind `false &&` may not have run.
  expect((await checkReadOnlyBash(`false && cd ${repo}\ngit status`, at(path.join(root, "loose")))).skip).toBe(false);
  // `!` turns a cd's failure into the success `&&` runs from.
  expect((await checkReadOnlyBash(`! cd ${repo} && git status`, at(path.join(root, "loose")))).skip).toBe(false);
  // A cd in a pipeline runs in a subshell and moves nothing after it.
  expect((await checkReadOnlyBash(`cd ${repo} | true; git status`, at(path.join(root, "loose")))).skip).toBe(false);
  // A relative start is not read.
  expect((await checkReadOnlyBash("ls", at("relative/dir"))).skip).toBe(false);
});

test("git reads skip only inside a registered repository", async () => {
  expect((await checkReadOnlyBash("git status", ctx)).skip).toBe(true);
  expect((await checkReadOnlyBash("git status", { ...ctx, cwd: path.join(repo, "src") })).skip).toBe(true);
  expect(await checkReadOnlyBash("git status", { ...ctx, cwd: path.join(root, "loose") })).toEqual({ skip: false, reason: "git-repo" });
  expect(await checkReadOnlyBash("git log", { ...ctx, cwd: path.join(repo, "nested") })).toEqual({ skip: false, reason: "git-repo" });
  // The deepest registered repository is the one git reads (a worktree inside a checkout).
  expect((await checkReadOnlyBash("git log", { ...ctx, cwd: path.join(repo, "nested"), registeredRepos: [repo, path.join(repo, "nested")] })).skip).toBe(true);
});

test("a redirect skips only to /dev/null or between stdout and stderr", async () => {
  for (const command of ["ls > /dev/null 2>&1", "rg x 2>/dev/null", "rg x 2>&1 | head", "ls &>/dev/null"]) {
    expect((await checkReadOnlyBash(command, ctx)).skip).toBe(true);
  }
  // Every write is the review's, wherever it goes.
  for (const command of ["echo hi >> notes.md", "printf 'a\\n' > n.md", "ls > out.txt", "ls 3>x", "ls >&3", `cd ${repo} && echo x > n.md`]) {
    expect((await checkReadOnlyBash(command, ctx)).skip).toBe(false);
  }
});

test("the check tells each program it read and the words it would get", async () => {
  const seen: string[][] = [];
  const verdict = await checkReadOnlyBash(`rg -n 'fn\\s+foo\\(' src | head -20; date '+%Y-%m-%d'`, { ...ctx, onCommand: (argv) => seen.push([...argv]) });
  expect(verdict.skip).toBe(true);
  expect(seen).toEqual([["rg", "-n", "fn\\s+foo\\(", "src"], ["head", "-20"], ["date", "+%Y-%m-%d"]]);
});

test("a program or subcommand named like what every object has is unknown, and reviewed", async () => {
  const lines = ["constructor x", "toString; ls", "hasOwnProperty", "__proto__", "tmux constructor", "tmux toString", "git constructor", "git valueOf"];
  const verdicts = await Promise.all(lines.map(async (line) => [line, (await checkReadOnlyBash(line, ctx)).skip]));
  expect(verdicts).toEqual(lines.map((line) => [line, false]));
});

test("a credential file, by its usual name or as one the caller names, is reviewed wherever the line reads it from", async () => {
  const named = [".git-credentials", "~/.npmrc", ".pypirc", ".kube/config", "home/.docker/config.json", ".config/gh/hosts.yml", ".codex/auth.json", ".claude/.credentials.json"];
  const read = await Promise.all(named.map(async (file) => [file, (await checkReadOnlyBash(`cat ${file}`, ctx)).skip]));
  expect(read).toEqual(named.map((file) => [file, false]));
  // A file the caller names as secret: by its full path, or relative to where the line stands.
  const data = path.join(root, "data");
  const secret = { ...ctx, secretFiles: [path.join(data, "config.json")] };
  expect((await checkReadOnlyBash(`cat ${path.join(data, "config.json")}`, secret)).skip).toBe(false);
  expect((await checkReadOnlyBash(`cd ${data} && head -5 config.json`, secret)).skip).toBe(false);
  expect((await checkReadOnlyBash("jq . --arg f config.json other.json", { ...secret, cwd: data })).skip).toBe(false);
  // Another config.json is only a file.
  expect((await checkReadOnlyBash("cat config.json", secret)).skip).toBe(true);
});

test("a credential read by a relative name from inside its folder, or by a pattern aimed at it, is reviewed", async () => {
  const home = path.join(root, "home");
  for (const dir of [".kube", ".docker", ".ssh"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const at = (cwd: string) => ({ ...ctx, cwd });
  expect((await checkReadOnlyBash("cat config", at(path.join(home, ".kube")))).skip).toBe(false);
  expect((await checkReadOnlyBash(`cd ${path.join(home, ".docker")} && cat config.json`, ctx)).skip).toBe(false);
  expect((await checkReadOnlyBash("cat known_hosts", at(path.join(home, ".ssh")))).skip).toBe(false);
  expect((await checkReadOnlyBash("cat .git-cred*", ctx)).skip).toBe(false);
  expect((await checkReadOnlyBash("head -5 .codex/auth.*", ctx)).skip).toBe(false);
  expect((await checkReadOnlyBash("cat .npm*", ctx)).skip).toBe(false);
});

test("a pattern aimed at a credential name is reviewed; one aimed at a file the caller names is the file system's", async () => {
  expect((await checkReadOnlyBash("cat /home/example/.config/gh/hosts.ym?", ctx)).skip).toBe(false);
  // Patterns that also meet ordinary files are searches, as before.
  expect((await checkReadOnlyBash("ls *.yml", ctx)).skip).toBe(true);
  // A caller-named secret counts by its path; a pattern that meets it is not chased.
  const data = path.join(root, "data");
  fs.mkdirSync(data, { recursive: true });
  expect((await checkReadOnlyBash("cat config.jso?", { ...ctx, cwd: data, secretFiles: [path.join(data, "config.json")] })).skip).toBe(true);
});
test("a secret file in a folder whose name holds pattern characters is still that file", async () => {
  const data = path.join(root, "mandate[1]");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "config.json"), "{}");
  const secret = { ...ctx, cwd: data, secretFiles: [path.join(data, "config.json")] };
  expect((await checkReadOnlyBash("cat config.json", secret)).skip).toBe(false);
  expect((await checkReadOnlyBash("cat other.json", secret)).skip).toBe(true);
});
test("a secret file named with dot segments or through a link to its folder is that file", async () => {
  const data = path.join(root, "data-dots");
  fs.mkdirSync(path.join(data, "sub"), { recursive: true });
  fs.writeFileSync(path.join(data, "config.json"), "{}");
  fs.symlinkSync(data, path.join(root, "data-dots-alias"));
  const secret = { ...ctx, cwd: data, secretFiles: [path.join(data, "config.json")] };
  expect((await checkReadOnlyBash("cat ./config.json", secret)).skip).toBe(false);
  expect((await checkReadOnlyBash("cat sub/../config.json", secret)).skip).toBe(false);
  expect((await checkReadOnlyBash(`cat ${path.join(root, "data-dots-alias", "config.json")}`, { ...secret, cwd: root })).skip).toBe(false);
});
