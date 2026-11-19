import { expect, test } from "bun:test";
import { TmuxPoller } from "../src/server/runtime/tmux-poller.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";

/** A tmux whose first pane listing waits until released. */
function gatedTmux() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let listings = 0;
  const client: TmuxClient = {
    socketArgs: [],
    runner: {
      run: async (_binary: string, args: string[]) => {
        if (args.includes("list-panes")) {
          listings += 1;
          if (listings === 1) await gate;
        }
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }
    }
  };
  return { client, release, listings: () => listings };
}

function poller(client: TmuxClient) {
  return new TmuxPoller({
    tmuxClient: client, analyzer: new Analyzer(), captureLines: 0,
    broadcaster: { emit: () => {}, broadcastSnapshot: () => {} },
    store: { listWorkerWindowKeys: () => new Set() }
  } as unknown as ConstructorParameters<typeof TmuxPoller>[0]);
}

test("a fresh poll waits for the one in flight, then reads tmux again", async () => {
  const tmux = gatedTmux();
  const p = poller(tmux.client);
  void p.poll();
  await new Promise((r) => setTimeout(r, 0));
  let done = false;
  const fresh = p.pollFresh().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 0));
  expect(done).toBe(false);
  tmux.release();
  await fresh;
  expect(tmux.listings()).toBe(2);
});

test("a fresh poll with nothing in flight is one poll", async () => {
  const tmux = gatedTmux();
  tmux.release();
  const p = poller(tmux.client);
  await p.pollFresh();
  expect(tmux.listings()).toBe(1);
});
