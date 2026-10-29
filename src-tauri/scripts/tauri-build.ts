#!/usr/bin/env bun
import { $ } from "bun";
import path from "node:path";
import { existsSync } from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
process.chdir(repoRoot);

const args = process.argv.slice(2);
const options = parseArgs(args);
if (options.help) {
  printHelp();
  process.exit(0);
}

const explicitTarget = targetFromArgs(options.tauriArgs);
const targetTriple = explicitTarget ?? (await hostTriple());
const tauriArgs = explicitTarget ? options.tauriArgs : [...options.tauriArgs, "--target", targetTriple];

if (!hasBundleArg(tauriArgs) && (options.app || options.zip)) {
  tauriArgs.push("--bundles", "app");
}

await $`bunx --bun --no-install tauri build ${tauriArgs}`;

if (!options.zip) {
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error("macOS zip packaging requires running this script on macOS");
}

const bundleDir = path.join(repoRoot, "src-tauri", "target", targetTriple, "release", "bundle", "macos");
const appPath = path.join(bundleDir, "Mandate.app");

if (!existsSync(appPath)) {
  throw new Error(`Expected macOS app bundle was not found: ${appPath}`);
}

const zipPath = path.join(bundleDir, `Mandate-macos-${macArchLabel(targetTriple)}.zip`);
await $`ditto -c -k --sequesterRsrc --keepParent ${appPath} ${zipPath}`;
console.log(`[tauri] macOS zip ready: ${path.relative(repoRoot, zipPath)}`);

function parseArgs(values: string[]) {
  const tauriArgs: string[] = [];
  let app = false;
  let zip = false;
  let help = false;

  for (const value of values) {
    if (value === "--app") {
      app = true;
      continue;
    }
    if (value === "--zip") {
      zip = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      help = true;
    }
    tauriArgs.push(value);
  }

  return { app, zip, help, tauriArgs };
}

function printHelp() {
  console.log(`Usage: bun run tauri:build -- [options] [tauri build options]

Options:
  --app    Build the macOS .app bundle instead of the default DMG.
  --zip    Build the .app bundle and additionally package it as a zip.

By default, Mandate builds the Tauri-configured bundle target: macOS DMG.
Other arguments are passed through to \`tauri build\`, for example --target.
`);
}

function targetFromArgs(values: string[]): string | undefined {
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === "--target" || value === "-t") {
      return values[index + 1]?.trim() || undefined;
    }
    if (value.startsWith("--target=")) {
      return value.slice("--target=".length).trim() || undefined;
    }
  }
  return undefined;
}

function hasBundleArg(values: string[]) {
  return values.some((value) => value === "--bundles" || value === "-b" || value.startsWith("--bundles="));
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

function macArchLabel(triple: string) {
  if (triple.startsWith("aarch64-")) return "arm64";
  if (triple.startsWith("x86_64-")) return "x86_64";
  return triple.replaceAll("-", "_");
}
