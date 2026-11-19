import { describe, expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  captureShellSnapshot,
  detectUserShell,
  stripSnapshotPreamble,
  wrapLoginFallback,
  wrapWithSnapshot
} from "../src/server/platform/process/shell-snapshot.js";
import { tempDir } from "./helpers/temp.js";
import { testShellRunner } from "./helpers/shell-runner.js";

describe("detectUserShell", () => {
  // passwdShell is always passed, so the host's own passwd entry is never read.
  const shells: { name: string; passwdShell: string | undefined; env: Record<string, string>; shell: ReturnType<typeof detectUserShell> }[] = [
    { name: "uses the passwd shell when it is a supported type",
      passwdShell: "/bin/zsh", env: {}, shell: { path: "/bin/zsh", type: "zsh" } },
    { name: "falls back to $SHELL when passwd shell is missing",
      passwdShell: undefined, env: { SHELL: "/opt/homebrew/bin/bash" }, shell: { path: "/opt/homebrew/bin/bash", type: "bash" } },
    { name: "falls back to /bin/bash for unsupported shells",
      passwdShell: "/usr/local/bin/fish", env: { SHELL: "/usr/local/bin/fish" }, shell: { path: "/bin/bash", type: "bash" } }
  ];

  test.each(shells)("$name", ({ passwdShell, env, shell }) => {
    expect(detectUserShell({ passwdShell, env })).toEqual(shell);
  });
});

describe("stripSnapshotPreamble", () => {
  test("drops rc noise before the snapshot marker", () => {
    const raw = "rc banner output\n# Snapshot file\nexport A=1\n";
    expect(stripSnapshotPreamble(raw)).toBe("# Snapshot file\nexport A=1\n");
  });

  test("returns null when the marker is missing", () => {
    expect(stripSnapshotPreamble("no marker here")).toBeNull();
  });
});

describe("wrapWithSnapshot", () => {
  test("sources the snapshot in the user's shell, then execs bash for the command", () => {
    const argv = wrapWithSnapshot("echo 'it'\"works\"", { path: "/bin/zsh", type: "zsh" }, "/tmp/snap dir/s.sh");
    expect(argv[0]).toBe("/bin/zsh");
    expect(argv[1]).toBe("-c");
    expect(argv[2]).toContain("if . '/tmp/snap dir/s.sh' >/dev/null 2>&1; then :; fi");
    expect(argv[2]).toContain("exec '/bin/bash' -c 'echo '\\''it'\\''\"works\"'");
  });
});

describe("wrapLoginFallback", () => {
  test("login shell for env, bash for interpretation", () => {
    const argv = wrapLoginFallback("echo 'x'", { path: "/bin/zsh", type: "zsh" });
    expect(argv[0]).toBe("/bin/zsh");
    expect(argv[1]).toBe("-lc");
    expect(argv[2]).toBe("exec '/bin/bash' -c 'echo '\\''x'\\'''");
  });
});

describe("bash interpretation under a zsh user", () => {
  const hasZsh = existsSync("/bin/zsh");
  test.if(hasZsh)("unmatched globs pass through instead of aborting (zsh nomatch regression)", async () => {
    const home = tempDir("snap-home-");
    writeFileSync(join(home, ".zshrc"), "export SNAP_ZSH_OK=1\n");
    const outPath = join(home, "snapshot.sh");
    const snapshotPath = await captureShellSnapshot({
      shell: { path: "/bin/zsh", type: "zsh" },
      outPath,
      env: { HOME: home, PATH: "/usr/bin:/bin", ZDOTDIR: home }
    });
    expect(snapshotPath).toBe(outPath);
    const argv = wrapWithSnapshot(
      'rm -f ./*.doesnotexist_tmp && echo -n "survived:$SNAP_ZSH_OK"',
      { path: "/bin/zsh", type: "zsh" },
      outPath
    );
    const proc = Bun.spawnSync({ cmd: argv, cwd: home });
    expect(proc.stdout.toString()).toBe("survived:1");
    expect(proc.exitCode).toBe(0);
  });
});

describe("captureShellSnapshot (real bash)", () => {
  test("returns null when the capture shell fails", async () => {
    const home = tempDir("snap-home-");
    const outPath = join(home, "snapshot.sh");
    const snapshotPath = await captureShellSnapshot({
      shell: { path: "/usr/bin/false", type: "bash" },
      outPath,
      env: { HOME: home, PATH: "/usr/bin:/bin" }
    });
    expect(snapshotPath).toBeNull();
    expect(existsSync(outPath)).toBe(false);
  });

});

// What the capture scripts write, read back from a made-up home directory. A
// snapshot has four parts in a fixed order: function definitions, options,
// aliases, exported variables; each of the last three sits under a heading
// that carries the number of lines below it.

type Snapshot = NonNullable<Awaited<ReturnType<typeof snapshotOf>>>;

async function snapshotOf(type: "zsh" | "bash", files: Record<string, string>, env: (home: string) => Record<string, string> = () => ({})) {
  const home = tempDir("snap-home-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(home, name)), { recursive: true });
    writeFileSync(join(home, name), content);
  }
  const shell = { path: `/bin/${type}`, type };
  const outPath = join(home, "snapshot.sh");
  const written = await captureShellSnapshot({ shell, outPath, env: { HOME: home, PATH: "/usr/bin:/bin", ...env(home) }, cwd: home });
  if (!written) return null;
  const text = readFileSync(outPath, "utf8");
  /** The lines under one heading, and the number the heading gives. */
  const part = (label: "options" | "aliases" | "exported variables") => {
    const heading = new RegExp(`^# ${label} \\((\\d+)\\)\\n`, "m").exec(text);
    if (!heading) throw new Error(`no "${label}" heading in:\n${text}`);
    const rest = text.slice(heading.index + heading[0].length);
    const next = /\n# (?:options|aliases|exported variables) \(\d+\)\n/.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest;
    return { count: Number(heading[1]), body, lines: body.split("\n").filter((line) => line !== "") };
  };
  /** What a command run behind this snapshot prints. */
  const run = (command: string) => Bun.spawnSync({ cmd: wrapWithSnapshot(command, shell, outPath), cwd: home, env: { PATH: "/usr/bin:/bin" } }).stdout.toString();
  return { home, text, part, run };
}

describe("what a zsh snapshot holds", () => {
  const hasZsh = existsSync("/bin/zsh");

  test.if(hasZsh)("plain and tied exports are carried; read-only ones, typed ones and where the capture ran are not", async () => {
    const snapshot = (await snapshotOf("zsh", {
      ".zshrc": [
        "export PLAIN='a b'",
        "typeset -xT TIED_LIST tied_list :",
        "tied_list=(/one '/two words')",
        "typeset -rx LOCKED=1",
        "typeset -rxT LOCKED_LIST locked_list",
        "typeset -xi COUNTED=7",
        "typeset -xl FOLDED=ABC",
        "cd /tmp && cd \"$HOME\"",
        "export PWD OLDPWD",
        ""
      ].join("\n")
    })) as Snapshot;
    const exported = snapshot.part("exported variables");
    expect(exported.lines).toContain("export PLAIN='a b'");
    expect(exported.lines).toContain("export -T TIED_LIST tied_list=( /one '/two words' )");
    expect(exported.lines.filter((line) => /LOCKED|COUNTED|FOLDED/.test(line))).toEqual([]);
    expect(exported.lines.filter((line) => /^export (?:-\w+ )?(?:PWD|OLDPWD)\b/.test(line))).toEqual([]);
    expect(exported.count).toBe(exported.lines.length);
    expect(snapshot.run('printf %s "$PLAIN|$TIED_LIST|${LOCKED-unset}|${COUNTED-unset}"')).toBe("a b|/one:/two words|unset|unset");
  });

  test.if(hasZsh)("a name exported without a value is carried as it is declared", async () => {
    // zsh 5.9 can declare without assigning; an older zsh has no such option and assigns ''.
    const canLeaveUnset = Bun.spawnSync({ cmd: ["/bin/zsh", "-c", "setopt typesettounset"], stderr: "ignore" }).exitCode === 0;
    const snapshot = (await snapshotOf("zsh", { ".zshrc": "setopt typesettounset 2>/dev/null\ntypeset -x DECLARED_ONLY\n" })) as Snapshot;
    const declared = snapshot.part("exported variables").lines.filter((line) => line.includes("DECLARED_ONLY"));
    expect(declared).toEqual([canLeaveUnset ? "export DECLARED_ONLY" : "export DECLARED_ONLY=''"]);
    // Unset stays unset for the command: it is not turned into an empty value.
    expect(snapshot.run('printf %s "${DECLARED_ONLY-unset}"')).toBe(canLeaveUnset ? "unset" : "");
  });

  test.if(hasZsh)("with allexport on, the capture adds no variable of its own", async () => {
    const names = (snapshot: Snapshot) => snapshot.part("exported variables").lines.map((line) => /^export (?:-\w+ )?(\w+)/.exec(line)?.[1]).sort();
    const plain = (await snapshotOf("zsh", { ".zshrc": "export MINE=1\n" })) as Snapshot;
    const everything = (await snapshotOf("zsh", { ".zshrc": "setopt allexport\nMINE=1\n" })) as Snapshot;
    expect(names(everything)).toStrictEqual(names(plain));
    expect(names(plain)).toContain("MINE");
  });

  test.if(hasZsh)("aliases are unset before the functions are defined, and options and aliases come as commands", async () => {
    const snapshot = (await snapshotOf("zsh", {
      ".zshrc": "greet() { print hi }\nalias ll='ls -l'\nalias -g G='| grep'\nsetopt extendedglob\n"
    })) as Snapshot;
    expect(snapshot.text.startsWith("# Snapshot file\n")).toBe(true);
    const unalias = snapshot.text.indexOf("\nunalias -a 2>/dev/null || true\n");
    expect(unalias).toBeGreaterThan(0);
    expect(snapshot.text.indexOf("\ngreet () {\n")).toBeGreaterThan(unalias);

    const options = snapshot.part("options");
    expect(options.lines).toContain("setopt extendedglob");
    expect(options.lines.filter((line) => !/^setopt \w+$/.test(line))).toEqual([]);
    expect(options.count).toBe(options.lines.length);

    const aliases = snapshot.part("aliases");
    expect(aliases.lines).toContain("alias ll='ls -l'");
    expect(aliases.lines).toContain("alias -g G='| grep'");
    expect(aliases.count).toBe(aliases.lines.length);
    // The parts come in this order, a blank line between them.
    expect(snapshot.text).toMatch(/\n\n# options \(\d+\)\n[^]*\n\n# aliases \(\d+\)\n[^]*\n\n# exported variables \(\d+\)\n/);
  });

  test.if(hasZsh)("a start-up directory whose name reads as a pattern is still the one read", async () => {
    // With these two options an unquoted path would be expanded as a pattern.
    const snapshot = await snapshotOf(
      "zsh",
      { ".zprofile": 'export ZDOTDIR="$HOME/[box]"\nsetopt globsubst globassign\n', "[box]/.zshrc": "unsetopt globassign\nexport FROM_BOX=1\n", ".zshenv": "alias source=false\n" },
    );
    expect(snapshot).not.toBeNull();
    expect((snapshot as Snapshot).part("exported variables").lines).toContain("export FROM_BOX=1");
  });

  test.if(hasZsh)("ZDOTDIR, when set, names the directory whose .zshrc is read", async () => {
    const files = { ".zshrc": "export FROM_HOME=1\n", "elsewhere/.zshrc": "export FROM_ZDOTDIR=1\n" };
    const moved = (await snapshotOf("zsh", files, (home) => ({ ZDOTDIR: join(home, "elsewhere") }))) as Snapshot;
    expect(moved.part("exported variables").lines.filter((line) => /FROM_/.test(line))).toEqual(["export FROM_ZDOTDIR=1"]);
    const atHome = (await snapshotOf("zsh", files)) as Snapshot;
    expect(atHome.part("exported variables").lines.filter((line) => /FROM_/.test(line))).toEqual(["export FROM_HOME=1"]);
    const empty = (await snapshotOf("zsh", files, () => ({ ZDOTDIR: "" }))) as Snapshot;
    expect(empty.part("exported variables").lines.filter((line) => /FROM_/.test(line))).toEqual(["export FROM_HOME=1"]);
  });
});

describe("what a bash snapshot holds", () => {
  test("a value of several lines is carried whole, and the heading counts the lines written", async () => {
    const snapshot = (await snapshotOf("bash", {
      ".bashrc": "export SEVERAL=$'one\\n\\nthree'\nexport SINGLE=1\ncd /tmp && cd \"$HOME\"\nexport PWD OLDPWD\n"
    })) as Snapshot;
    const exported = snapshot.part("exported variables");
    expect(exported.body).toContain('declare -x SEVERAL="one\n\nthree"\n');
    expect(exported.body).toContain('declare -x SINGLE="1"\n');
    expect(exported.lines.filter((line) => /^declare -\w+ (?:PWD|OLDPWD)\b/.test(line))).toEqual([]);
    // A blank line inside a value is written but not counted.
    expect(exported.count).toBe(exported.lines.length);
    expect(exported.body.split("\n").length - 1).toBe(exported.count + 1);
    expect(snapshot.run('printf %s "$SEVERAL|$SINGLE"')).toBe("one\n\nthree|1");
  });

  test("the options that are on come as commands, and a start-up file's errexit is not one of them", async () => {
    const snapshot = (await snapshotOf("bash", { ".bashrc": "set -o noclobber\nset -e\n" })) as Snapshot;
    const options = snapshot.part("options");
    expect(options.lines).toContain("set -o noclobber");
    expect(options.lines).toContain("set -o hashall");
    expect(options.lines).not.toContain("set -o errexit");
    expect(options.lines.filter((line) => !/^set -o [\w-]+$/.test(line))).toEqual([]);
    expect(options.count).toBe(options.lines.length);
    // The parts come in this order, a blank line between them.
    expect(snapshot.text).toMatch(/^# Snapshot file\n[^]*\n# function definitions\n\n# options \(\d+\)\n[^]*\n\n# aliases \(0\)\n\n# exported variables \(\d+\)\n/);
  });

  test("no alias is listed, and one from the start-up file cannot rewrite the capture", async () => {
    const snapshot = (await snapshotOf("bash", {
      ".bashrc": "shopt -s expand_aliases\nalias ll='ls -l'\nalias declare='false'\nalias compgen='false'\ngreet() { echo hi; }\nexport AFTER_ALIASES=1\n"
    })) as Snapshot;
    expect(snapshot.part("aliases")).toMatchObject({ count: 0, lines: [] });
    expect(snapshot.text).not.toContain("alias ");
    expect(snapshot.text).toContain("\ngreet () \n{ \n    echo hi\n}\n");
    expect(snapshot.part("exported variables").lines).toContain('declare -x AFTER_ALIASES="1"');
    expect(snapshot.text.startsWith("# Snapshot file\n")).toBe(true);
  });

  test("with allexport on, the capture adds no variable of its own", async () => {
    const names = (snapshot: Snapshot) => snapshot.part("exported variables").lines.map((line) => /^declare -\w+ (\w+)/.exec(line)?.[1]).sort();
    const plain = (await snapshotOf("bash", { ".bashrc": "export MINE=1\n" })) as Snapshot;
    const everything = (await snapshotOf("bash", { ".bashrc": "set -a\nMINE=1\n" })) as Snapshot;
    expect(names(everything)).toStrictEqual(names(plain));
    expect(names(plain)).toContain("MINE");
  });

  test("a start-up file with errexit on does not end the capture where a command of it fails", async () => {
    // With aliases expanding, "unalias" itself can be made to fail.
    const snapshot = await snapshotOf("bash", { ".bashrc": "shopt -s expand_aliases\nalias unalias=false\nset -e\nexport AFTER_ERREXIT=1\n" });
    expect(snapshot).not.toBeNull();
    expect((snapshot as Snapshot).part("exported variables").lines).toContain('declare -x AFTER_ERREXIT="1"');
  });

  test("an alias for a word the capture reads its start-up file with does not keep the file unread", async () => {
    const snapshot = (await snapshotOf("bash", { ".bash_profile": "shopt -s expand_aliases\nalias source=false\n", ".bashrc": "export STILL_READ=1\n" })) as Snapshot;
    expect(snapshot.part("exported variables").lines).toContain('declare -x STILL_READ="1"');
  });

  test("keyword mode, where any name=value argument is taken for an assignment, does not break the capture", async () => {
    const snapshot = await snapshotOf("bash", { ".bashrc": "export KEEP_ME=ok\nset -k\n" });
    expect(snapshot).not.toBeNull();
    expect((snapshot as Snapshot).part("options").lines).toContain("set -o keyword");
    expect((snapshot as Snapshot).part("aliases").count).toBe(0);
    expect((snapshot as Snapshot).part("exported variables").lines).toContain('declare -x KEEP_ME="ok"');
  });

  test("nothing exported at all is a snapshot with no exported variable, pipefail or not", async () => {
    const snapshot = await snapshotOf("bash", { ".bashrc": "export -n $(compgen -e)\nset -o pipefail\n" });
    expect(snapshot).not.toBeNull();
    expect((snapshot as Snapshot).part("exported variables")).toMatchObject({ count: 0, lines: [] });
    expect((snapshot as Snapshot).part("options").lines).toContain("set -o pipefail");
  });

  test("a failing step in the walk over the exported names does not empty the list under errexit", async () => {
    // With IFS read-only, the walk's own "IFS= read" reports an error each time.
    const snapshot = (await snapshotOf("bash", { ".bashrc": "readonly IFS\nset -e\nexport KEPT_ANYWAY=ok\n" })) as Snapshot;
    expect(snapshot.part("exported variables").lines).toContain('declare -x KEPT_ANYWAY="ok"');
    expect(snapshot.run('printf %s "$KEPT_ANYWAY"')).toBe("ok");
  });

  test("an accented name in the environment is no shell name, whatever the locale's collation says", async () => {
    const snapshot = await snapshotOf("bash", { ".bashrc": "export LC_ALL=en_US.UTF-8\nexport PLAIN_ONE=1\n" }, () => ({ "ÉCOLE": "yes" }));
    expect(snapshot).not.toBeNull();
    const exported = (snapshot as Snapshot).part("exported variables");
    expect(exported.lines).toContain('declare -x PLAIN_ONE="1"');
    expect(exported.lines.filter((line) => line.includes("COLE"))).toEqual([]);
  });

  test("a name in the environment that the shell could not assign is passed over", async () => {
    // "-f" would be read by declare as its own option and print every function.
    const snapshot = (await snapshotOf("bash", { ".bashrc": "greet() { echo hi; }\nexport REAL_ONE=1\n" }, () => ({ "-f": "x", "NOT-A-NAME": "y", "9LIVES": "z" }))) as Snapshot;
    const exported = snapshot.part("exported variables");
    expect(exported.lines).toContain('declare -x REAL_ONE="1"');
    expect(exported.lines.filter((line) => !/^declare -[a-z]+ [A-Za-z_][A-Za-z0-9_]*=/.test(line))).toEqual([]);
  });

  test("an alias that survives is listed, and the heading counts every line of it", async () => {
    // "unalias" made to fail leaves the alias in force; its value has an empty line.
    const snapshot = (await snapshotOf("bash", { ".bashrc": "unalias() { return 1; }\nalias several=$'echo one\\n\\necho two'\n" })) as Snapshot;
    const aliases = snapshot.part("aliases");
    expect(aliases.body).toBe("alias several='echo one\n\necho two'\n");
    expect(aliases.count).toBe(3);
  });

  test("with BASH_ENV set, .bashrc is left unread", async () => {
    const files = { ".bashrc": "export FROM_BASHRC=1\n", "env.sh": "export FROM_BASH_ENV=1\n" };
    const withEnv = (await snapshotOf("bash", files, (home) => ({ BASH_ENV: join(home, "env.sh") }))) as Snapshot;
    expect(withEnv.part("exported variables").lines.filter((line) => /FROM_/.test(line))).toEqual(['declare -x FROM_BASH_ENV="1"']);
    const without = (await snapshotOf("bash", files)) as Snapshot;
    expect(without.part("exported variables").lines.filter((line) => /FROM_/.test(line))).toEqual(['declare -x FROM_BASHRC="1"']);
  });

  test("a start-up file that changes IFS still gets a whole snapshot", async () => {
    const snapshot = await snapshotOf("bash", { ".bashrc": "IFS=:\nexport AFTER_IFS='a:b'\n" });
    expect(snapshot).not.toBeNull();
    const options = (snapshot as Snapshot).part("options");
    expect(options.lines).toContain("set -o hashall");
    expect(options.lines.filter((line) => !/^set -o [\w-]+$/.test(line))).toEqual([]);
    expect((snapshot as Snapshot).part("exported variables").lines).toContain('declare -x AFTER_IFS="a:b"');
  });
});

describe("shell command runner robustness", () => {
  const makeRunner = () => {
    const home = tempDir("snap-home-");
    writeFileSync(join(home, ".bashrc"), "export RUNNER_HOME_OK=1\n");
    return {
      home,
      runner: testShellRunner(home)
    };
  };

  test("a TERM-trapping command cannot outlive the timeout", async () => {
    const { home, runner } = makeRunner();
    const started = Date.now();
    const result = await runner.run("trap '' TERM; sleep 30; echo -n never", {
      cwd: home,
      timeoutMs: 500
    });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(result.stderr).toContain("timed out");
    expect(result.stdout).not.toContain("never");
  }, 15000);

  test("stdin is closed so stdin-readers finish immediately instead of timing out", async () => {
    const { home, runner } = makeRunner();
    const result = await runner.run("cat; echo -n done", { cwd: home, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");
  });

  test("large multibyte output survives chunked pipes without replacement characters", async () => {
    const { home, runner } = makeRunner();
    const result = await runner.run(
      'for i in $(seq 1 20000); do printf "汉语测试abc"; done',
      { cwd: home, timeoutMs: 30000 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(20000 * "汉语测试abc".length);
    expect(result.stdout.includes("�")).toBe(false);
  }, 40000);

  test("a snapshot file deleted mid-lifetime falls back to a working login shell", async () => {
    const { home, runner } = makeRunner();
    const first = await runner.run("echo -n one", { cwd: home, timeoutMs: 10000 });
    expect(first.exitCode).toBe(0);
    rmSync(join(home, "snapshot-bash.sh"));
    const second = await runner.run("echo -n two", { cwd: home, timeoutMs: 10000 });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("two");
  });

  test("snapshot survives a data dir containing shell metacharacters", async () => {
    const home = tempDir("snap-ho$me-");
    writeFileSync(join(home, ".bashrc"), "export META_OK=1\n");
    const outPath = join(home, "snapshot.sh");
    const snapshotPath = await captureShellSnapshot({
      shell: { path: "/bin/bash", type: "bash" },
      outPath,
      env: { HOME: home, PATH: "/usr/bin:/bin" }
    });
    expect(snapshotPath).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });
});

describe("shell command runner snapshot integration", () => {
  test("runs commands with the captured user environment", async () => {
    const home = tempDir("snap-home-");
    writeFileSync(join(home, ".bashrc"), "export MANDATE_RUNNER_SENTINEL=runner-sees-me\n");
    const runner = testShellRunner(home);
    const result = await runner.run("echo -n \"$MANDATE_RUNNER_SENTINEL\"", {
      cwd: home,
      timeoutMs: 10000
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("runner-sees-me");
  });

  test("falls back to a plain login shell when capture fails", async () => {
    const home = tempDir("snap-home-");
    const runner = testShellRunner(home, {
      shell: { path: "/usr/bin/false", type: "bash" },
      fallbackShell: { path: "/bin/bash", type: "bash" }
    });
    const result = await runner.run("echo -n fallback-ok", { cwd: home, timeoutMs: 10000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("fallback-ok");
  });
});
