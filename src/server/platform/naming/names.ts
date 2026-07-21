import { resolveDataDir } from "../fs/data-dir.js";
import { sha256 } from "../crypto/hash.js";

const PROJECT_PREFIX = "md-";
const PROJECT_SESSION_HASH_LENGTH = 10;

function baseSanitize(input: string): string {
  const collapsed = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return collapsed;
}

export interface ProjectSessionNameOptions {
  dataDir?: string;
}

export function projectSessionHashForDataDir(dataDir: string): string {
  return sha256(dataDir).slice(0, PROJECT_SESSION_HASH_LENGTH);
}

function currentProjectSessionHash(options: ProjectSessionNameOptions = {}): string {
  return projectSessionHashForDataDir(options.dataDir ?? resolveDataDir());
}

export function projectSessionNameForDataDir(name: string, dataDir: string, suffix?: number): string {
  const base = baseSanitize(name);
  if (!base) throw new Error("project name sanitizes to empty");
  const suffixText = suffix && suffix > 1 ? `-${suffix}` : "";
  return `${PROJECT_PREFIX}${base}${suffixText}-${projectSessionHashForDataDir(dataDir)}`;
}

export function resolveProjectSessionNameCollision(
  name: string,
  isTaken: (candidate: string) => boolean,
  options: ProjectSessionNameOptions = {}
): string {
  const dataDir = options.dataDir ?? resolveDataDir();
  const first = projectSessionNameForDataDir(name, dataDir);
  if (!isTaken(first)) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = projectSessionNameForDataDir(name, dataDir, i);
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`could not resolve collision for ${first}`);
}

export function isCurrentProjectSessionName(
  sessionName: string,
  options: ProjectSessionNameOptions = {}
): boolean {
  return sessionName.startsWith(PROJECT_PREFIX) && sessionName.endsWith(`-${currentProjectSessionHash(options)}`);
}

export function sanitizeFeatureName(name: string): string {
  const base = baseSanitize(name);
  if (!base) throw new Error("feature name sanitizes to empty");
  return base;
}

export function resolveCollision(base: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`could not resolve collision for ${base}`);
}
