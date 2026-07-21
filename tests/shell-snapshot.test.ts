import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureShellSnapshot,
  detectUserShell,
  shellSingleQuote,
  stripSnapshotPreamble,
  wrapLoginFallback,
  wrapWithSnapshot
} from "../src/server/platform/process/shell-snapshot.js";
import { createShellCommandRunner } from "../src/server/platform/process/shell-command-runner.js";

describe("detectUserShell", () => {
  test("uses the passwd shell when it is a supported type", () => {
    const shell = detectUserShell({ passwdShell: "/bin/zsh", env: {} });
    expect(shell).toEqual({ path: "/bin/zsh", type: "zsh" });
  });

  test("falls back to $SHELL when passwd shell is missing", () => {
    const shell = detectUserShell({ passwdShell: undefined, env: { SHELL: "/opt/homebrew/bin/bash" } });
    expect(shell).toEqual({ path: "/opt/homebrew/bin/bash", type: "bash" });
  });

  test("falls back to /bin/bash for unsupported shells", () => {
    const shell = detectUserShell({ passwdShell: "/usr/local/bin/fish", env: { SHELL: "/usr/local/bin/fish" } });
    expect(shell).toEqual({ path: "/bin/bash", type: "bash" });
  });
});

describe("shellSingleQuote", () => {
  test("escapes embedded single quotes", () => {
    expect(shellSingleQuote("echo 'hi'")).toBe("echo '\\''hi'\\''");
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
    const home = mkdtempSync(join(tmpdir(), "snap-home-"));
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
  test("captures exports from the user's rc and a wrapped command sees them", async () => {
    const home = mkdtempSync(join(tmpdir(), "snap-home-"));
    writeFileSync(join(home, ".bashrc"), "export MANDATE_SNAPSHOT_SENTINEL=sentinel-value-42\n");
    const outPath = join(home, "snapshot.sh");

    const snapshotPath = await captureShellSnapshot({
      shell: { path: "/bin/bash", type: "bash" },
      outPath,
      env: { HOME: home, PATH: "/usr/bin:/bin" }
    });

    expect(snapshotPath).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, "utf8")).toContain("MANDATE_SNAPSHOT_SENTINEL");

    const argv = wrapWithSnapshot("echo -n \"$MANDATE_SNAPSHOT_SENTINEL\"", { path: "/bin/bash", type: "bash" }, outPath);
    const proc = Bun.spawnSync({ cmd: argv });
    expect(proc.stdout.toString()).toBe("sentinel-value-42");
  });

  test("returns null when the capture shell fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "snap-home-"));
    const outPath = join(home, "snapshot.sh");
    const snapshotPath = await captureShellSnapshot({
      shell: { path: "/usr/bin/false", type: "bash" },
      outPath,
      env: { HOME: home, PATH: "/usr/bin:/bin" }
    });
    expect(snapshotPath).toBeNull();
    expect(existsSync(outPath)).toBe(false);
  });

  test("excludes PWD and OLDPWD from captured exports", async () => {
    const home = mkdtempSync(join(tmpdir(), "snap-home-"));
    writeFileSync(join(home, ".bashrc"), "export KEEP_ME=yes\n");
    const outPath = join(home, "snapshot.sh");
    await captureShellSnapshot({
      shell: { path: "/bin/bash", type: "bash" },
      outPath,
      env: { HOME: home, PATH: "/usr/bin:/bin" }
    });
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("KEEP_ME");
    expect(content).not.toMatch(/declare -x PWD=/);
    expect(content).not.toMatch(/declare -x OLDPWD=/);
  });
});

describe("shell command runner robustness", () => {
  const makeRunner = () => {
    const home = mkdtempSync(join(tmpdir(), "snap-home-"));
    writeFileSync(join(home, ".bashrc"), "export RUNNER_HOME_OK=1\n");
    return {
      home,
      runner: createShellCommandRunner({
        shell: { path: "/bin/bash", type: "bash" },
        snapshotDir: home,
        captureEnv: { HOME: home, PATH: "/usr/bin:/bin" }
      })
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

  test("a background child holding the pipes does not hang the call past the timeout", async () => {
    const { home, runner } = makeRunner();
    const started = Date.now();
    const result = await runner.run("sleep 30 & echo -n started", {
      cwd: home,
      timeoutMs: 500
    });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(result.stdout).toContain("started");
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
    const home = mkdtempSync(join(tmpdir(), "snap-ho$me-"));
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
    const home = mkdtempSync(join(tmpdir(), "snap-home-"));
    writeFileSync(join(home, ".bashrc"), "export MANDATE_RUNNER_SENTINEL=runner-sees-me\n");
    const runner = createShellCommandRunner({
      shell: { path: "/bin/bash", type: "bash" },
      snapshotDir: home,
      captureEnv: { HOME: home, PATH: "/usr/bin:/bin" }
    });
    const result = await runner.run("echo -n \"$MANDATE_RUNNER_SENTINEL\"", {
      cwd: home,
      timeoutMs: 10000
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("runner-sees-me");
  });

  test("falls back to a plain login shell when capture fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "snap-home-"));
    const runner = createShellCommandRunner({
      shell: { path: "/usr/bin/false", type: "bash" },
      fallbackShell: { path: "/bin/bash", type: "bash" },
      snapshotDir: home,
      captureEnv: { HOME: home, PATH: "/usr/bin:/bin" }
    });
    const result = await runner.run("echo -n fallback-ok", { cwd: home, timeoutMs: 10000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("fallback-ok");
  });
});
