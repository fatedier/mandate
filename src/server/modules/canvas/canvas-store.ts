import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentScope,
  CanvasDocumentDto,
  CanvasKind,
  CanvasListItemDto,
  DesignSnapshot
} from "../../../shared/api-contracts.js";
import { canvasSourceFilePath, resourcesRoot, type ResourceOwner } from "../../platform/fs/resources.js";
import { CANVAS_PAGE_MAX_BYTES, CANVAS_TITLE_MAX_CHARS } from "../../../shared/canvas-page.js";
import { readCanvasTitle } from "./canvas-html.js";
import { parseDesignIndex } from "./design-index.js";
import { newId } from "../../platform/ids.js";
import { errorText } from "../../../shared/error-text.js";

export interface CanvasDocument extends CanvasDocumentDto {
  filePath: string;
}
type CanvasListItem = CanvasListItemDto;

interface CreateCanvasInput {
  title: string;
  scope: AgentScope;
  scopeId: string | null;
  threadId: string;
  projectId?: string | null;
  kind?: CanvasKind;
}

interface UpdateCanvasInput {
  id: string;
  title: string;
}

interface RawCanvasDocument {
  id: string;
  title: string;
  kind: string;
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
  file_path: string;
  thread_id: string;
  created_at: string;
  updated_at: string;
}

interface RawCanvasListItem {
  id: string;
  title: string;
  kind: string;
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

function readKind(value: string): CanvasKind {
  return value === "design" ? "design" : "report";
}

/** A design's published snapshot; one that cannot be read, or is not the
 *  shape a publish writes, is treated as unpublished. */
function readSnapshot(text: string): DesignSnapshot | undefined {
  if (!text) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const snapshot = value as Partial<DesignSnapshot> | null;
  const index = snapshot?.index;
  const ok = typeof snapshot === "object" && snapshot !== null &&
    typeof snapshot.artboards === "object" && snapshot.artboards !== null && !Array.isArray(snapshot.artboards) &&
    typeof index === "object" && index !== null &&
    Array.isArray(index.boards) && index.boards.length > 0 &&
    Array.isArray(index.pages) && index.pages.length > 0 && Array.isArray(index.notes) &&
    typeof index.launch === "object" && index.launch !== null &&
    (index.launch.view === "canvas" || index.launch.view === "focused");
  return ok ? (snapshot as DesignSnapshot) : undefined;
}

function toCanvas(row: RawCanvasDocument): CanvasDocument {
  const kind = readKind(row.kind);
  const design = kind === "design" ? readSnapshot(row.html) : undefined;
  return {
    id: row.id,
    title: row.title,
    kind,
    html: kind === "design" ? "" : row.html,
    ...(design ? { design } : {}),
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
    kind: readKind(row.kind),
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
    const kind = input.kind ?? "report";
    const filePath = canvasSourceFilePath({
      canvasId: id,
      owner: resourceOwner(projectId),
      fileName: kind === "design" ? "canvas.json" : "index.html",
      dataDir: this.dataDir
    });
    ensureCanvasSourceDir(filePath);
    this.db.prepare(`
      insert into canvas_documents
        (id, title, html, scope, scope_id, project_id, file_path, thread_id, created_at, updated_at, kind)
      values
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now,
      kind
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

  /** The names of those of these canvases that are there. */
  titlesOf(ids: readonly string[]): Array<{ id: string; title: string; kind: CanvasKind }> {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`select id, title, kind from canvas_documents where id in (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as Array<{ id: string; title: string; kind: string }>;
    return rows.map((row) => ({ id: row.id, title: row.title, kind: readKind(row.kind) }));
  }

  /** Every canvas, newest first, at most `limit` of them: Your agent's page
   *  lists them. */
  listAll(limit: number): CanvasListItem[] {
    const rows = this.db
      .prepare(`${canvasListSelectSql} ${canvasListOrderSql} limit ?`)
      .all(limit) as RawCanvasListItem[];
    return rows.map(toCanvasListItem);
  }

  /** All canvases scoped to a feature, newest first. Unpaginated — a feature
   *  accumulates few canvases (one bound dashboard + occasional artifacts). */
  listForFeature(featureId: string): CanvasListItem[] {
    const rows = this.db
      .prepare(`${canvasListSelectSql} where c.scope = 'worker' and c.scope_id = ? ${canvasListOrderSql}`)
      .all(featureId) as RawCanvasListItem[];
    return rows.map(toCanvasListItem);
  }

  /** A manager thread's canvases, newest first: the ones it wrote, and those
   *  of the workers named (the thread's own, active and archived). */
  listForThread(threadId: string, featureIds: readonly string[]): CanvasListItem[] {
    const workers = featureIds.length > 0
      ? ` or (c.scope = 'worker' and c.scope_id in (${featureIds.map(() => "?").join(",")}))`
      : "";
    const rows = this.db
      .prepare(`${canvasListSelectSql} where (c.scope = 'manager' and c.thread_id = ?)${workers} ${canvasListOrderSql}`)
      .all(threadId, ...featureIds) as RawCanvasListItem[];
    return rows.map(toCanvasListItem);
  }

  /** Deletes a canvas for good: its own folder first, then its row, so a
   *  folder that cannot be removed leaves the canvas to try again (the error
   *  says why). A file kept anywhere but the canvas's own folder is left
   *  alone. Returns what was deleted, or null when there was no such canvas. */
  delete(id: string): CanvasDocument | null {
    const canvas = this.getById(id);
    if (!canvas) return null;
    const folder = this.ownFolder(id, canvas.filePath);
    if (folder) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch (err) {
        throw new Error(`could not remove the canvas's files: ${errorText(err)}`);
      }
    }
    this.db.prepare(`delete from canvas_documents where id = ?`).run(id);
    return canvas;
  }

  /** The folder a canvas's source file sits in, when it is that canvas's own —
   *  `<resources>/<owner>/canvases/<id>`, whichever owner it was made under —
   *  and nothing on the way to it is a symlink: its real path must be the
   *  lexical one, rebased on the real resources root. Else null, and no file
   *  is touched. */
  private ownFolder(id: string, filePath: string): string | null {
    const folder = path.dirname(path.resolve(filePath));
    const ownName = path.basename(path.dirname(canvasSourceFilePath({ canvasId: id, owner: { kind: "global" }, dataDir: this.dataDir })));
    if (path.basename(folder) !== ownName || path.basename(path.dirname(folder)) !== "canvases") return null;
    const root = path.resolve(resourcesRoot(this.dataDir));
    const relative = path.relative(root, folder);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    try {
      return fs.realpathSync(folder) === path.join(fs.realpathSync(root), relative) ? folder : null;
    } catch (err) {
      // Only a folder that is not there needs no removing: any other failure
      // (a folder that cannot be searched) keeps the canvas, to try again.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`could not remove the canvas's files: ${errorText(err)}`);
    }
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

  /** Reads the canvas's source file into the html column, takes the title
   *  from its <title>, and bumps updated_at and the revision. Refuses a page
   *  over 16 MB. */
  publishSource(id: string): { canvas?: CanvasDocument; error?: string; warnings?: string[] } {
    const existing = this.getById(id);
    if (!existing) return { error: "canvas not found" };
    if (existing.kind === "design") return this.publishDesign(existing, existing.filePath);
    let content: string;
    let bytes: number;
    try {
      // Sized on disk first: an oversized page is refused without reading it.
      bytes = fs.statSync(existing.filePath).size;
      content = bytes > CANVAS_PAGE_MAX_BYTES ? "" : fs.readFileSync(existing.filePath, "utf8");
    } catch (err) {
      const message = errorText(err);
      return { error: `canvas source file could not be read: ${message}` };
    }
    if (bytes > CANVAS_PAGE_MAX_BYTES) {
      const mb = (bytes / 1024 / 1024).toFixed(1);
      return {
        error: `The page is ${mb} MB, over the 16 MB limit. Move images and other large files next to index.html and reference them by relative path; files there don't count.`
      };
    }
    // The page's <title> names it; the create-time title
    // is the fallback for a page without one.
    const title = readCanvasTitle(content) ?? existing.title;
    const now = new Date().toISOString();
    this.db.prepare(`
      update canvas_documents
      set html = ?, title = ?, updated_at = ?, content_revision = content_revision + 1
      where id = ?
    `).run(content, title, now, id);
    return { canvas: this.getById(id)! };
  }

  /** A design's publish: canvas.json and every artboard it
   *  lists become one snapshot. Sized on disk before anything is read. */
  private publishDesign(existing: CanvasDocument, indexPath: string): { canvas?: CanvasDocument; error?: string; warnings?: string[] } {
    // Real paths: the path rule keeps a name inside the folder, but a symlink
    // (canvas.json, an artboard, or a folder on the way) could still lead out of it.
    let folder: string;
    let indexText: string;
    try {
      folder = fs.realpathSync(path.dirname(indexPath));
      const indexFile = fs.realpathSync(indexPath);
      if (!indexFile.startsWith(folder + path.sep)) return { error: "canvas.json is outside the canvas folder." };
      // A folder or a named pipe is not read (a pipe would block the publish).
      const indexStat = fs.statSync(indexFile);
      if (!indexStat.isFile()) return { error: "canvas.json is not a file." };
      if (indexStat.size > CANVAS_PAGE_MAX_BYTES) {
        return { error: `canvas.json is ${(indexStat.size / 1024 / 1024).toFixed(1)} MB, over the 16 MB limit for a whole design. Keep the index to its boards, pages and notes.` };
      }
      indexText = fs.readFileSync(indexFile, "utf8");
    } catch {
      return { error: `No canvas.json yet: write the index at ${indexPath}, then publish.` };
    }
    const parsed = parseDesignIndex(indexText);
    if ("error" in parsed) return { error: parsed.error };
    let total = Buffer.byteLength(indexText, "utf8");
    const files: Array<{ path: string; file: string }> = [];
    for (const board of parsed.index.boards) {
      let file: string;
      let stat: fs.Stats;
      try {
        file = fs.realpathSync(path.join(folder, board.path));
        stat = fs.statSync(file);
      } catch {
        return { error: `"${board.path}" is listed in canvas.json but not found next to it.` };
      }
      if (!file.startsWith(folder + path.sep)) return { error: `"${board.path}" is outside the canvas folder.` };
      if (!stat.isFile()) return { error: `"${board.path}" is not a file.` };
      total += stat.size;
      files.push({ path: board.path, file });
    }
    if (total > CANVAS_PAGE_MAX_BYTES) {
      const mb = (total / 1024 / 1024).toFixed(1);
      return {
        error: `The design is ${mb} MB across canvas.json and its artboards, over the 16 MB limit. Move images and other large files next to the artboards and reference them by relative path; files there don't count.`
      };
    }
    const artboards: Record<string, string> = {};
    try {
      for (const { path: boardPath, file } of files) artboards[boardPath] = fs.readFileSync(file, "utf8");
    } catch (err) {
      return { error: `An artboard could not be read: ${errorText(err)}` };
    }
    const snapshot: DesignSnapshot = { index: parsed.index, artboards };
    const title = parsed.index.title ? [...parsed.index.title].slice(0, CANVAS_TITLE_MAX_CHARS).join("") : existing.title;
    const now = new Date().toISOString();
    this.db.prepare(`
      update canvas_documents
      set html = ?, title = ?, updated_at = ?, content_revision = content_revision + 1
      where id = ?
    `).run(JSON.stringify(snapshot), title, now, existing.id);
    return { canvas: this.getById(existing.id)!, warnings: parsed.warnings };
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
    try {
      return { content: fs.readFileSync(existing.filePath, "utf8") };
    } catch (err) {
      const message = errorText(err);
      return { error: `canvas source file could not be read: ${message}` };
    }
  }

  writeSource(id: string, content: string): { error?: string } {
    const existing = this.getById(id);
    if (!existing) return { error: "canvas not found" };
    try {
      fs.writeFileSync(existing.filePath, content, "utf8");
      return {};
    } catch (err) {
      const message = errorText(err);
      return { error: `canvas source file could not be written: ${message}` };
    }
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
    c.kind,
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
    c.kind,
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
