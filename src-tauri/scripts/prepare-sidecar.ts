#!/usr/bin/env bun
import { $ } from "bun";
import path from "node:path";
import { chmodSync, existsSync, mkdirSync } from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
process.chdir(repoRoot);

const debug = process.argv.includes("--debug");
const explicitTargetTriple = valueAfter("--target-triple");

function bunTargetForTriple(triple: string): string {
  switch (triple) {
    case "x86_64-apple-darwin":
      return "bun-darwin-x64";
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    default:
      throw new Error(`Unsupported Tauri sidecar target: ${triple}`);
  }
}

function tripleFromTauriEnv(): string {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE.trim();
  }

  const arch = process.env.TAURI_ENV_ARCH?.trim();
  const platform = process.env.TAURI_ENV_PLATFORM?.trim();
  if (!arch || !platform) return "";
  if (platform === "darwin" || platform === "macos") {
    if (arch === "x86_64") return "x86_64-apple-darwin";
    if (arch === "aarch64" || arch === "arm64") return "aarch64-apple-darwin";
  }
  return "";
}

async function hostTriple(): Promise<string> {
  try {
    return (await $`rustc --print host-tuple`.text()).trim();
  } catch {
    const verbose = await $`rustc -Vv`.text();
    const hostLine = verbose.split("\n").find((line) => line.startsWith("host: "));
    if (!hostLine) throw new Error("Could not determine Rust host triple");
    return hostLine.replace("host: ", "").trim();
  }
}

const triple = explicitTargetTriple || tripleFromTauriEnv() || await hostTriple();
const outDir = path.join(repoRoot, "src-tauri", "binaries");
const outfile = path.join(outDir, `mandate-${triple}`);
mkdirSync(outDir, { recursive: true });

const target = bunTargetForTriple(triple);
const flags = ["--out", outfile, "--target", target];
if (debug && existsSync(path.join(repoRoot, "dist", "client"))) {
  flags.push("--skip-client");
}

console.log(`[tauri] building sidecar for ${triple} (${target})`);
await $`bun scripts/build-binary.ts ${flags}`;
chmodSync(outfile, 0o755);
console.log(`[tauri] sidecar ready: ${path.relative(repoRoot, outfile)}`);

function valueAfter(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) return "";
  return process.argv[index + 1]?.trim() ?? "";
}
