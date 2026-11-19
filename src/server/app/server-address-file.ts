import * as fs from "node:fs";
import * as path from "node:path";
import { nodeTextFileSystem, type TextFileSystem } from "../platform/fs/text-file-system.js";

/** Where a running server listens, as it says so itself. */
export interface ServerAddress {
  /** The server's own process. Whoever started a server knows which one is
   *  theirs by this; a file left by a server that died names a dead one. */
  pid: number;
  /** The address it bound, as configured. */
  host: string;
  /** The port it bound: the real one when it was started on port 0. */
  port: number;
  /** An address a program on this machine can open. */
  url: string;
}

/**
 * A server writes where it listens into its data directory once it has bound
 * its port, and takes the file away when it leaves. Whatever started it can
 * then let the system choose the port (port 0) and read it back, where it
 * used to pick a free port itself and hand it over: a port picked that way
 * can be taken before the server binds it, and "the port answers" does not
 * say whose server answers.
 *
 * The file says where a server is. It is not a lock: the server never reads
 * it, and one left behind by a crash is harmless.
 */
export function serverAddressPath(dataDir: string): string {
  return path.join(dataDir, "server.json");
}

/** Written beside the file and moved into place, so a reader never sees half
 *  of it; a write that cannot finish leaves nothing behind. */
export function writeServerAddress(
  dataDir: string,
  bound: Pick<ServerAddress, "pid" | "host" | "port">,
  files: Pick<TextFileSystem, "atomicWriteText"> = nodeTextFileSystem
): void {
  const address: ServerAddress = { pid: bound.pid, host: bound.host, port: bound.port, url: localUrl(bound.host, bound.port) };
  files.atomicWriteText(serverAddressPath(dataDir), `${JSON.stringify(address, null, 2)}\n`, ".server-address");
}

/** The address in the directory's file; null when there is none or it is
 *  not one. */
export function readServerAddress(dataDir: string): ServerAddress | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(serverAddressPath(dataDir), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { pid, host, port, url } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || typeof host !== "string" || typeof port !== "number" || typeof url !== "string") return null;
  return { pid, host, port, url };
}

/** Takes the file away if it is this server's. A server that stops late must
 *  not remove the file of the one that followed it. */
export function removeServerAddress(dataDir: string, pid: number): void {
  if (readServerAddress(dataDir)?.pid !== pid) return;
  fs.rmSync(serverAddressPath(dataDir), { force: true });
}

/** The address a program on this machine opens: a server listening on every
 *  address is reached on the loopback one, and an IPv6 address goes in
 *  brackets. */
export function localUrl(host: string, port: number): string {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const reachable = bare === "0.0.0.0" ? "127.0.0.1" : bare === "::" ? "::1" : bare;
  return `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${port}`;
}
