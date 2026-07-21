#!/usr/bin/env bun
// Build a single-file Bun binary with the React client embedded.
//
// Inspired by opencode's script/build.ts: we generate a virtual TypeScript
// module that statically imports every file in dist/client/ via
// `import x from "..." with { type: "file" }` and exports a path map. Bun's
// `--compile` mode embeds those files into the binary, and the runtime
// resolves the import to a /$bunfs/ path that `Bun.file` can read.

import { $ } from "bun";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..");
process.chdir(repoRoot);

const skipClient = process.argv.includes("--skip-client");
const outfile = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]!
  : "bin/mandate";

mkdirSync(path.dirname(outfile), { recursive: true });

function defaultBunTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `bun-${os}-${process.arch}`;
}
const target = process.argv.includes("--target")
  ? process.argv[process.argv.indexOf("--target") + 1]!
  : defaultBunTarget();

if (!skipClient) {
  console.log("[1/3] Building client (vite)...");
  await $`bun run --bun vite build`;
} else {
  console.log("[1/3] Skipping client build (--skip-client)");
}

console.log("[2/3] Building embedded file map...");
const distClient = path.join(repoRoot, "dist", "client");
if (!existsSync(distClient)) {
  console.error("dist/client/ missing — run `bun run build` first or omit --skip-client");
  process.exit(1);
}

const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: distClient })))
  .filter((f) => !f.endsWith(".map"))
  .sort();
console.log(`  embedding ${files.length} files`);

const imports = files.map((f, i) => {
  const rel = "./" + path.relative(repoRoot, path.join(distClient, f)).replaceAll("\\", "/");
  return `import file_${i} from ${JSON.stringify(rel)} with { type: "file" };`;
});
const entries = files.map((f, i) => `  ${JSON.stringify(f)}: file_${i},`);

const embeddedFileMap = [
  "// GENERATED at compile time — do not edit",
  ...imports,
  "const map: Record<string, string> = {",
  ...entries,
  "};",
  "export default map;",
  "",
].join("\n");

console.log("[2b/3] Building embedded skills map...");
const skillsRoot = path.join(repoRoot, "src", "server", "modules", "skills", "builtins");
// Glob everything under each skill dir — SKILL.md AND references/* — so the
// read_skill_reference tool can resolve embedded reference files via the
// same manifest. Excludes dotfiles and scripts/* (latter is read-only docs;
// we don't run skill scripts anyway).
const skillFiles = existsSync(skillsRoot)
  ? (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: skillsRoot, onlyFiles: true })))
      .filter((f) => !f.split("/").some((seg) => seg.startsWith(".")) && !f.includes("/scripts/"))
      .sort()
  : [];
console.log(`  embedding ${skillFiles.length} skill file(s)`);

const skillImports = skillFiles.map((f, i) => {
  const rel = "./" + path.relative(repoRoot, path.join(skillsRoot, f)).replaceAll("\\", "/");
  return `import skill_${i} from ${JSON.stringify(rel)} with { type: "file" };`;
});
const skillEntries = skillFiles.map((f, i) => `  ${JSON.stringify(f)}: skill_${i},`);

const embeddedSkillsMap = [
  "// GENERATED at compile time — do not edit",
  ...skillImports,
  "const map: Record<string, string> = {",
  ...skillEntries,
  "};",
  "export default map;",
  ""
].join("\n");

console.log("[3/3] Compiling binary...");
const result = await Bun.build({
  entrypoints: ["./src/server/server.ts", "mandate-web-ui.gen.ts", "mandate-skills.gen.ts"],
  files: {
    "mandate-web-ui.gen.ts": embeddedFileMap,
    "mandate-skills.gen.ts": embeddedSkillsMap
  },
  compile: {
    target: target as `bun-${string}-${string}`,
    outfile,
  },
  minify: true,
  format: "esm",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`✓ Built ./${outfile}`);
