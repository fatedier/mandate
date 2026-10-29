import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { MemoryBrief, MemoryEntry, MemoryScope } from "./types.js";

interface BriefRow {
  scope: MemoryScope;
  project_id: string;
  content: string;
  input_digest: string;
  built_at: string;
  run_id: string | null;
}

function briefFromRow(row: BriefRow): MemoryBrief {
  return {
    scope: row.scope,
    projectId: row.project_id === "" ? null : row.project_id,
    content: row.content,
    inputDigest: row.input_digest,
    builtAt: row.built_at,
    runId: row.run_id
  };
}

export function getBrief(db: Database, scope: MemoryScope, projectId: string | null): MemoryBrief | null {
  const row = db.prepare("select * from memory_briefs where scope = ? and project_id = ?")
    .get(scope, projectId ?? "") as BriefRow | null;
  return row ? briefFromRow(row) : null;
}

export function putBrief(db: Database, brief: MemoryBrief): void {
  db.prepare(`
    insert into memory_briefs (scope, project_id, content, input_digest, built_at, run_id)
    values (?, ?, ?, ?, ?, ?)
    on conflict(scope, project_id) do update set
      content = excluded.content,
      input_digest = excluded.input_digest,
      built_at = excluded.built_at,
      run_id = excluded.run_id
  `).run(brief.scope, brief.projectId ?? "", brief.content, brief.inputDigest, brief.builtAt, brief.runId);
}

export function deleteBrief(db: Database, scope: MemoryScope, projectId: string | null): void {
  db.prepare("delete from memory_briefs where scope = ? and project_id = ?").run(scope, projectId ?? "");
}

/** The user brief first, then projects by id. */
export function listBriefs(db: Database): MemoryBrief[] {
  const rows = db.prepare(`
    select * from memory_briefs
    order by case scope when 'user' then 0 else 1 end, project_id
  `).all() as BriefRow[];
  return rows.map(briefFromRow);
}

/** What a brief was built from: its partition's available memories, each
 *  id with its update time. A brief whose digest differs from its partition's
 *  current one is out of date. A project's covers its own memories only: its
 *  run checks them against the user's, but a change to the user's alone does
 *  not send every project back to a run. */
export function entriesDigest(entries: ReadonlyArray<Pick<MemoryEntry, "id" | "updatedAt">>): string {
  const lines = entries.map((entry) => `${entry.id}:${entry.updatedAt}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
