import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";

// A server that could not bind its port logged the failure and stayed up:
// what it had started before the bind kept the process alive, with nothing
// listening. Started a second time by mistake, it sat there for ever; in this
// suite a server that lost its port to another file's looked alive, and the
// file's tests ran against the other one. It says why and exits now. Only the
// compiled binary, run as a process of its own, can show a process ending.

const BINARY = path.join(process.cwd(), "bin", "mandate");

test("a server whose port is taken says so and exits with a failure, instead of staying up with nothing listening", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-bind-"));
  // Something else has the port.
  const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = holder.port;
  const server = Bun.spawn([BINARY, "serve"], {
    env: { ...process.env, PORT: String(port), MANDATE_DATA_DIR: dataDir },
    stdout: "pipe", stderr: "pipe"
  });
  try {
    const ended = await Promise.race([server.exited, Bun.sleep(15_000).then(() => "still running after 15s" as const)]);
    expect(ended).toBe(1);
    const said = await new Response(server.stderr).text();
    // Where it could not listen, and why, in the same words whichever step found it.
    expect(said).toContain(`mandate: could not listen on http://127.0.0.1:${port}: the address is already in use`);
    // It never claimed to be listening.
    expect(await new Response(server.stdout).text()).not.toContain("Mandate listening on");
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    holder.stop(true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);

// The address is tried twice: before anything is built (below), and when the
// server binds it. Between the two the application is built, and the address
// can be taken meanwhile. That second failure is the one that used to leave
// the process up. A fresh data directory shows where the server is: its
// database appears only once the first try has passed.
test("an address taken while the server is still starting ends it the same way", async () => {
  // The server can win the race for the port; then it is tried again.
  for (let attempt = 1; ; attempt += 1) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-bind-late-"));
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const server = Bun.spawn([BINARY, "serve"], {
      env: { ...process.env, PORT: String(port), MANDATE_DATA_DIR: dataDir },
      stdout: "pipe", stderr: "pipe"
    });
    let holder: { stop(closeActiveConnections?: boolean): void } | null = null;
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(path.join(dataDir, "mandate.db")) && Date.now() < deadline) await Bun.sleep(1);
      // Past the first try, or this would only show the first try again.
      expect(fs.existsSync(path.join(dataDir, "mandate.db"))).toBe(true);
      try {
        holder = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      } catch {
        // The server had bound it already.
        if (attempt < 5) continue;
        throw new Error("the server bound its port before the test could take it, five times over");
      }
      const ended = await Promise.race([server.exited, Bun.sleep(15_000).then(() => "still running after 15s" as const)]);
      expect(ended).toBe(1);
      expect(await new Response(server.stderr).text()).toContain(`mandate: could not listen on http://127.0.0.1:${port}: the address is already in use`);
      expect(await new Response(server.stdout).text()).not.toContain("Mandate listening on");
      return;
    } finally {
      server.kill("SIGKILL");
      await server.exited;
      holder?.stop(true);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}, 90_000);

// The first try has to ask what the bind will ask: an address the server can
// bind must not be turned away by a check that reads it differently. A
// bracketed IPv6 literal is one the server's own listener takes and a bare
// TCP one does not.
test("an address written as the server's own listener takes it is not turned away by the first try", async () => {
  const host = "[::1]";
  let port: number;
  try {
    const probe = Bun.serve({ hostname: host, port: 0, fetch: () => new Response(null) });
    port = probe.port!;
    await probe.stop(true);
  } catch {
    console.log("[server-bind] no IPv6 loopback here: the bracketed address is not tried");
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-e2e-bind-v6-"));
  const server = Bun.spawn([BINARY, "serve"], {
    env: { ...process.env, PORT: String(port), MANDATE_HOST: host, MANDATE_DATA_DIR: dataDir },
    stdout: "pipe", stderr: "pipe"
  });
  try {
    const answered = async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          if ((await fetch(`http://${host}:${port}/api/settings/config`, { signal: AbortSignal.timeout(1000) })).ok) return "answers";
        } catch { /* not listening yet */ }
        await Bun.sleep(100);
      }
      return "no answer in 20s";
    };
    const outcome = await Promise.race([answered(), server.exited.then((code) => `exited ${code}`)]);
    expect(outcome).toBe("answers");
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);

// The whole application was built before the port was tried. A second server
// started by mistake on a running one's data directory therefore ran the
// start-up steps first, and those take every turn recorded as running for one
// a dead server left behind: they mark it failed and answer its open tool
// calls with "interrupted", under the server that is still running it. The
// address is tried before anything of the data directory is opened now.
test("a second server on a running one's data directory and port leaves before it touches the data: a turn in progress stays as it is", async () => {
  const first = await startServer({ configured: true, label: "server-bind-first" });
  const store = new MandateStore(first.dataDir);
  try {
    // A turn the first server is in the middle of, one tool call still out.
    const agents = new AgentStore(store.db);
    const thread = agents.createManagerThread("project-1 cache expiry");
    const wake = agents.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    agents.appendMessage({
      threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id,
      content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call_1", toolName: "bash", args: { command: "bun run test" } }] }
    });
    const turn = () => ({ status: agents.getWakeById(wake.id)!.status, messages: agents.getActiveMessages(thread.id).map((m) => m.content.type) });
    expect(turn()).toEqual({ status: "running", messages: ["assistant"] });

    const second = Bun.spawn([BINARY, "serve"], {
      env: { ...process.env, PORT: new URL(first.baseUrl).port, MANDATE_DATA_DIR: first.dataDir },
      stdout: "pipe", stderr: "pipe"
    });
    try {
      const ended = await Promise.race([second.exited, Bun.sleep(15_000).then(() => "still running after 15s" as const)]);
      expect(ended).toBe(1);
      expect(await new Response(second.stderr).text()).toContain(`mandate: could not listen on ${first.baseUrl}: the address is already in use`);
    } finally {
      second.kill("SIGKILL");
      await second.exited;
    }
    // Not failed, and no "interrupted" answer written into its conversation.
    expect(turn()).toEqual({ status: "running", messages: ["assistant"] });
    // The first server is as it was.
    expect((await fetch(`${first.baseUrl}/api/settings/config`)).status).toBe(200);
  } finally {
    store.db.close();
    first.cleanup();
  }
}, 60_000);
