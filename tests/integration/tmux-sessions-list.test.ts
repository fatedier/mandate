import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { startFakeTmuxServer } from "../helpers/fake-tmux.js";
import { MandateStore } from "../../src/server/app/store.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { tmuxNewSession } from "../../src/server/platform/tmux/tmux.js";
import { buildSessionsTestApp, getJson } from "../helpers/test-app.js";

test("GET /api/tmux/sessions classifies sessions as managed vs unmanaged", async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-db-"));
  const tmux = startFakeTmuxServer();
  try {
    const store = new MandateStore(dbDir);
    const projects = new ProjectsStore(store.db);

    // Seed: one project (managed) + one external session (unmanaged)
    const projectId = projects.insert({
      name: "MyApp", workingDir: "/tmp",
      isGit: false, gitRemote: null,
      tmuxSessionName: "md-myapp", ownership: "app"
    });
    tmuxNewSession("md-myapp", "/tmp", tmux.client);
    tmuxNewSession("external-thing", "/tmp", tmux.client);

    const app = buildSessionsTestApp({
      projects,
      tmuxClient: tmux.client,
      getRawState: () => null,
      refreshWindows: () => {}
    });
    const r = await getJson(app, "/api/tmux/sessions");
    expect(r.status).toBe(200);
    const byName = new Map<string, any>(r.body.sessions.map((s: any) => [s.name, s]));

    const managed = byName.get("md-myapp");
    expect(managed).toBeTruthy();
    expect(managed.ownership).toBe("managed");
    expect(managed.projectId).toBe(projectId);
    expect(managed.projectName).toBe("MyApp");
    expect(Array.isArray(managed.windows)).toBeTruthy();

    const unmanaged = byName.get("external-thing");
    expect(unmanaged).toBeTruthy();
    expect(unmanaged.ownership).toBe("unmanaged");
    expect(unmanaged.projectId).toBe(null);
    expect(Array.isArray(unmanaged.windows)).toBeTruthy();
  } finally {
    tmux.cleanup();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
