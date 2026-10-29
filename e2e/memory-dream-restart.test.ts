import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";

// A dream run the last server left in flight (a restart, a deploy) is closed
// when the server starts: failed, saying why, not "running" for good.
let server: RunningServer;
beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      store.db.prepare(`insert into memory_dream_runs (id, trigger, status, provider, model, candidate_count, applied_count, error_json, metadata_json, started_at, finished_at, available_count_before, available_count_after, phase, project_id)
        values ('drm_cut', 'idle', 'running', 'openai', 'gpt-5.5', 2, 0, null, null, '2026-10-16T07:16:53.000Z', null, 2, null, 'user', null)`).run();
      store.db.close();
    }
  });
}, 60_000);
afterAll(() => server?.cleanup());

test("a dream run left running by the last server is closed as failed when the server starts", async () => {
  const body = await (await fetch(`${server.baseUrl}/api/memory/dream/runs`)).json() as { runs: Array<{ id: string; status: string; finishReason: string | null; finishedAt: string | null }> };
  const cut = body.runs.find((run) => run.id === "drm_cut");
  expect(cut).toMatchObject({ status: "failed", finishReason: "The server restarted during this run." });
  expect(cut!.finishedAt).not.toBeNull();
});
