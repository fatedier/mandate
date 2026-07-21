import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentScope,
  CanvasDocumentDto,
  CanvasListItemDto
} from "../../../shared/api-contracts.js";
import { canvasSourceFilePath, type ResourceOwner } from "../../platform/fs/resources.js";
import { newId } from "../../platform/ids.js";

export interface CanvasDocument extends CanvasDocumentDto {
  filePath: string | null;
}
export type CanvasListItem = CanvasListItemDto;

export interface CreateCanvasInput {
  title: string;
  scope: AgentScope;
  scopeId: string | null;
  threadId: string;
  projectId?: string | null;
}

export interface UpdateCanvasInput {
  id: string;
  title: string;
}

interface RawCanvasDocument {
  id: string;
  title: string;
  html: string;
  content_revision: number;
  scope: string;
  scope_id: string | null;
  project_id: string | null;
  project_name: string | null;
  project_slug: string | null;
  feature_id: string | null;
  feature_name: string | null;
  feature_slug: string | null;
  file_path: string | null;
  thread_id: string;
  created_at: string;
  updated_at: string;
}

interface RawCanvasListItem {
  id: string;
  title: string;
  scope: string;
  scope_id: string | null;
  thread_id: string;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  project_name: string | null;
  project_slug: string | null;
  feature_id: string | null;
  feature_name: string | null;
  feature_slug: string | null;
}

function toCanvas(row: RawCanvasDocument): CanvasDocument {
  return {
    id: row.id,
    title: row.title,
    kind: "html",
    html: row.html,
    contentRevision: row.content_revision,
    scope: row.scope as AgentScope,
    scopeId: row.scope_id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectSlug: row.project_slug,
    featureId: row.feature_id,
    featureName: row.feature_name,
    featureSlug: row.feature_slug,
    filePath: row.file_path,
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toCanvasListItem(row: RawCanvasListItem): CanvasListItem {
  return {
    id: row.id,
    title: row.title,
    kind: "html",
    scope: row.scope as AgentScope,
    scopeId: row.scope_id,
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectId: row.project_id,
    projectName: row.project_name,
    projectSlug: row.project_slug,
    featureId: row.feature_id,
    featureName: row.feature_name,
    featureSlug: row.feature_slug
  };
}

export class CanvasStore {
  constructor(private readonly db: Database, private readonly dataDir: string) {}

  create(input: CreateCanvasInput): CanvasDocument {
    const id = newId("cnv");
    const now = new Date().toISOString();
    const projectId = input.projectId ?? null;
    const filePath = canvasSourceFilePath({
      canvasId: id,
      owner: resourceOwner(projectId),
      fileName: "index.html",
      dataDir: this.dataDir
    });
    ensureCanvasSourceDir(filePath);
    this.db.prepare(`
      insert into canvas_documents
        (id, title, html, scope, scope_id, project_id, file_path, thread_id, created_at, updated_at)
      values
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      "",
      input.scope,
      input.scopeId,
      projectId,
      filePath,
      input.threadId,
      now,
      now
    );
    return this.getById(id)!;
  }

  getById(id: string): CanvasDocument | null {
    const row = this.db.prepare(`
      ${canvasDetailSelectSql}
      where c.id = ?
    `).get(id) as RawCanvasDocument | undefined;
    return row ? toCanvas(row) : null;
  }

  /** All canvases scoped to a feature, newest first. Unpaginated — a feature
   *  accumulates few canvases (one bound dashboard + occasional artifacts). */
  listForFeature(featureId: string): CanvasListItem[] {
    const rows = this.db
      .prepare(`${canvasListSelectSql} where c.scope = 'worker' and c.scope_id = ? ${canvasListOrderSql}`)
      .all(featureId) as RawCanvasListItem[];
    return rows.map(toCanvasListItem);
  }

  update(input: UpdateCanvasInput): CanvasDocument | null {
    const existing = this.getById(input.id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      update canvas_documents
      set title = ?, updated_at = ?
      where id = ?
    `).run(
      input.title,
      now,
      input.id
    );
    return this.getById(input.id);
  }

  /** Reads the canvas's source HTML file into the html column and bumps
   *  updated_at. */
  publishSource(id: string): { canvas?: CanvasDocument; error?: string } {
    const existing = this.getById(id);
    if (!existing) return { error: "canvas not found" };
    if (!existing.filePath) return { error: "canvas has no source file" };
    let content: string;
    try {
      content = fs.readFileSync(existing.filePath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `canvas source file could not be read: ${message}` };
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      update canvas_documents
      set html = ?, updated_at = ?, content_revision = content_revision + 1
      where id = ?
    `).run(content, now, id);
    return { canvas: this.getById(id)! };
  }

  /**
   * The source file's current text, or why it cannot be read.
   *
   * Separate from `publishSource` because the outline and the removal both work
   * on the source rather than the rendered copy: publishing reads this file, so
   * anything that edited only the stored HTML would have its change undone by
   * the next publish.
   */
  readSource(id: string): { content?: string; error?: string } {
    const existing = this.getById(id);
    if (!existing) return { error: "canvas not found" };
    if (!existing.filePath) return { error: "canvas has no source file" };
    try {
      return { content: fs.readFileSync(existing.filePath, "utf8") };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `canvas source file could not be read: ${message}` };
    }
  }

  writeSource(id: string, content: string): { error?: string } {
    const existing = this.getById(id);
    if (!existing) return { error: "canvas not found" };
    if (!existing.filePath) return { error: "canvas has no source file" };
    try {
      fs.writeFileSync(existing.filePath, content, "utf8");
      return {};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `canvas source file could not be written: ${message}` };
    }
  }

  appendEvent(input: {
    canvasId: string;
    threadId: string;
    action: string;
    data: unknown;
  }): string {
    const id = newId("cevt");
    const now = new Date().toISOString();
    this.db.prepare(`
      insert into canvas_events
        (id, canvas_id, thread_id, action, data_json, created_at)
      values
        (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.canvasId,
      input.threadId,
      input.action,
      stableStringify(input.data),
      now
    );
    return id;
  }
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}

function resourceOwner(projectId: string | null): ResourceOwner {
  return projectId ? { kind: "project", projectId } : { kind: "global" };
}

function ensureCanvasSourceDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

const canvasListSelectSql = `
  select
    c.id,
    c.title,
    c.scope,
    c.scope_id,
    c.thread_id,
    c.created_at,
    c.updated_at,
    coalesce(cp.id, p.id) as project_id,
    coalesce(cp.name, p.name) as project_name,
    coalesce(cp.tmux_session_name, p.tmux_session_name) as project_slug,
    f.id as feature_id,
    f.name as feature_name,
    f.tmux_window_name as feature_slug
  from canvas_documents c
  left join features f
    on c.scope = 'worker' and c.scope_id = f.id
  left join projects p
    on f.project_id = p.id
  left join projects cp
    on c.project_id = cp.id
`;

const canvasDetailSelectSql = `
  select
    c.id,
    c.title,
    c.html,
    c.content_revision,
    c.scope,
    c.scope_id,
    coalesce(cp.id, p.id) as project_id,
    coalesce(cp.name, p.name) as project_name,
    coalesce(cp.tmux_session_name, p.tmux_session_name) as project_slug,
    f.id as feature_id,
    f.name as feature_name,
    f.tmux_window_name as feature_slug,
    c.file_path,
    c.thread_id,
    c.created_at,
    c.updated_at
  from canvas_documents c
  left join features f
    on c.scope = 'worker' and c.scope_id = f.id
  left join projects p
    on f.project_id = p.id
  left join projects cp
    on c.project_id = cp.id
`;

const canvasListOrderSql = "order by c.updated_at desc, c.id desc";
