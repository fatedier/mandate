import { processExists } from "../platform/process/parent-watch.js";
import { readServerAddress, type ServerAddress } from "./server-address-file.js";

/** How `mandate serve` exits when another server holds its data directory
 *  (EX_TEMPFAIL): the desktop shell reads it (DATA_DIR_IN_USE_EXIT in
 *  src-tauri/src/lib.rs) and shows why instead of restarting into the same
 *  refusal. */
export const DATA_DIR_IN_USE_EXIT_CODE = 75;

/** The server that holds the directory, as its own address file names it:
 *  only a process that is still there, and not this one. */
export function runningHolder(
  dataDir: string,
  options: { exists?: (pid: number) => boolean; self?: number } = {}
): ServerAddress | null {
  const address = readServerAddress(dataDir);
  if (!address || address.pid === (options.self ?? process.pid)) return null;
  return (options.exists ?? processExists)(address.pid) ? address : null;
}

export function dataDirInUseMessage(dataDir: string, holder: ServerAddress | null): string {
  const who = holder ? ` (pid ${holder.pid}, ${holder.url})` : "";
  return `mandate: another Mandate server is already using ${dataDir}${who}. Stop it first, or start this one with --data-dir set to another directory.`;
}

/** Said at start when this system could not lock the directory: the server
 *  runs, but nothing stops a second one on the same directory. */
export function dataDirUnguardedMessage(dataDir: string, reason: string): string {
  return `mandate: could not lock ${dataDir} (${reason}), so another server started on it would not be stopped.`;
}
