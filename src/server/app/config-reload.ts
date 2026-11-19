import type { Config } from "../config.js";
import { ConfigFileError } from "../config/file-check.js";

/** A reload while running: the file's config, or null when the server
 *  would refuse the file (said through `log`), so the running one stays. */
export function reloadOrKeep(read: () => Config, log: (error: ConfigFileError) => void): Config | null {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof ConfigFileError)) throw error;
    log(error);
    return null;
  }
}
