import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { TmuxClient } from "../../src/server/platform/tmux/tmux.js";

interface TestServer {
  client: TmuxClient;
  cleanup: () => void;
}

export function startTestTmuxServer(): TestServer {
  const socketName = `ap-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "md-tmux-"));
  const configPath = path.join(tmpdir, "tmux.conf");
  fs.writeFileSync(
    configPath,
    [
      "set-option -g default-shell /bin/sh",
      "set-option -g default-command /bin/sh"
    ].join("\n") + "\n"
  );
  const client: TmuxClient = { socketArgs: ["-f", configPath, "-L", socketName] };
  // No-op kill-server up-front so socket is fresh; status irrelevant
  spawnSync("tmux", [...client.socketArgs, "kill-server"], { timeout: 1500 });
  return {
    client,
    cleanup: () => {
      spawnSync("tmux", [...client.socketArgs, "kill-server"], { timeout: 1500 });
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
}
