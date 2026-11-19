import type { LogLevel } from "../platform/logger.js";

/** What `mandate serve`'s flags gave. Every read of config.json takes these
 *  over the file's own values, so a reload after a Settings save keeps them.
 *  Set once, before the server's first read. */
export type StartOverrides = { port?: number; host?: string; logLevel?: LogLevel };

let current: StartOverrides = {};

export function setStartOverrides(next: StartOverrides): void {
  current = { ...next };
}

export function startOverrides(): StartOverrides {
  return current;
}
