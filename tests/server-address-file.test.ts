import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { localUrl, readServerAddress, removeServerAddress, serverAddressPath, writeServerAddress } from "../src/server/app/server-address-file.js";
import { tempDir } from "./helpers/temp.js";

// Whatever starts a server had to pick its port for it, and to take "the
// port answers" for "my server is up": two servers started at once could be
// handed one port, and the loser's starter then talked to the winner. The
// server now says where it listens, in a file in its own data directory, so
// a starter can let the system choose the port and read it back, and can
// tell its own server by the process id.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function dataDir(): string {
  const dir = tempDir("md-address-file-");
  dirs.push(dir);
  return dir;
}

test("the address is written whole, as one file in the data directory, and read back", () => {
  const dir = dataDir();
  expect(readServerAddress(dir)).toBeNull();
  writeServerAddress(dir, { pid: 4242, host: "127.0.0.1", port: 51234 });
  expect(serverAddressPath(dir)).toBe(path.join(dir, "server.json"));
  expect(JSON.parse(fs.readFileSync(serverAddressPath(dir), "utf8"))).toEqual({ pid: 4242, host: "127.0.0.1", port: 51234, url: "http://127.0.0.1:51234" });
  expect(readServerAddress(dir)).toEqual({ pid: 4242, host: "127.0.0.1", port: 51234, url: "http://127.0.0.1:51234" });
  // Written beside it and moved into place: nothing else is left behind.
  expect(fs.readdirSync(dir)).toEqual(["server.json"]);
  // The next server on this directory replaces it.
  writeServerAddress(dir, { pid: 4343, host: "127.0.0.1", port: 51235 });
  expect(readServerAddress(dir)).toEqual({ pid: 4343, host: "127.0.0.1", port: 51235, url: "http://127.0.0.1:51235" });
  expect(fs.readdirSync(dir)).toEqual(["server.json"]);
  // The host is kept as it was bound; the url is the one to open.
  writeServerAddress(dir, { pid: 4343, host: "0.0.0.0", port: 51235 });
  expect(readServerAddress(dir)).toEqual({ pid: 4343, host: "0.0.0.0", port: 51235, url: "http://127.0.0.1:51235" });
});

test("it is put there whole: written by the one writer that moves a finished file into place, never in place", () => {
  const dir = dataDir();
  const wrote: Array<[string, string]> = [];
  writeServerAddress(dir, { pid: 4242, host: "127.0.0.1", port: 51234 }, {
    atomicWriteText: (file, contents) => { wrote.push([file, contents]); }
  });
  expect(wrote.map(([file, contents]) => [file, JSON.parse(contents)])).toStrictEqual([
    [serverAddressPath(dir), { pid: 4242, host: "127.0.0.1", port: 51234, url: "http://127.0.0.1:51234" }]
  ]);
  // Nothing was written past that writer.
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("a write that cannot finish says so and leaves nothing half-made behind", () => {
  const dir = dataDir();
  // Something that is no file stands where the address goes.
  fs.mkdirSync(serverAddressPath(dir));
  expect(() => writeServerAddress(dir, { pid: 4242, host: "127.0.0.1", port: 51234 })).toThrow();
  expect(fs.readdirSync(dir)).toEqual(["server.json"]);
});

test("the url is one a program on this machine can open", () => {
  expect(localUrl("127.0.0.1", 4175)).toBe("http://127.0.0.1:4175");
  expect(localUrl("localhost", 4175)).toBe("http://localhost:4175");
  // Listening on every address is reached on the loopback one.
  expect(localUrl("0.0.0.0", 4175)).toBe("http://127.0.0.1:4175");
  expect(localUrl("::", 4175)).toBe("http://[::1]:4175");
  expect(localUrl("[::]", 4175)).toBe("http://[::1]:4175");
  // An IPv6 address goes in brackets, once.
  expect(localUrl("::1", 4175)).toBe("http://[::1]:4175");
  expect(localUrl("[::1]", 4175)).toBe("http://[::1]:4175");
  expect(localUrl("fe80::1", 4175)).toBe("http://[fe80::1]:4175");
});

test("a file that is not an address is none", () => {
  const dir = dataDir();
  for (const text of ["", "{", "null", "[]", JSON.stringify({ pid: 1, host: "127.0.0.1", port: 1 }), JSON.stringify({ pid: "1", host: "127.0.0.1", port: 1, url: "http://127.0.0.1:1" }),
    JSON.stringify({ pid: 1, host: "127.0.0.1", port: "1", url: "http://127.0.0.1:1" }), JSON.stringify({ pid: 1, host: "127.0.0.1", port: 1, url: 7 })]) {
    fs.writeFileSync(serverAddressPath(dir), text);
    expect([text, readServerAddress(dir)]).toEqual([text, null]);
  }
});

test("a server takes its own file away when it leaves, and leaves another's alone", () => {
  const dir = dataDir();
  // Nothing there: nothing to do.
  removeServerAddress(dir, 4242);
  writeServerAddress(dir, { pid: 4343, host: "127.0.0.1", port: 51235 });
  // A server that stops late must not take away the file of the one that followed it.
  removeServerAddress(dir, 4242);
  expect(readServerAddress(dir)?.pid).toBe(4343);
  removeServerAddress(dir, 4343);
  expect(fs.existsSync(serverAddressPath(dir))).toBe(false);
  // What is not an address is not this server's to remove.
  fs.writeFileSync(serverAddressPath(dir), "{");
  removeServerAddress(dir, 4343);
  expect(fs.existsSync(serverAddressPath(dir))).toBe(true);
});
