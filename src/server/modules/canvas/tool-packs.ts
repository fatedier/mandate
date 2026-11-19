import type { z } from "zod";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { AgentScope, CanvasKind } from "../../../shared/api-contracts.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { ToolContext, ToolDefinition } from "../agent/tool-registry.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { CanvasDocument, CanvasStore } from "./canvas-store.js";
import { canvasOutline, removeCanvasBlock } from "./canvas-outline.js";
import { checkCanvasPage } from "./canvas-checks.js";
import { canvasDescription } from "./canvas-contract.js";
import { managerCanvasParams, workerCanvasParams, type CanvasParams } from "./tool-packs-schema.js";

/**
 * Where a canvas stops being read. Set from pages that were read rather than
 * taste: a typical canvas of a few thousand visible characters reads well;
 * every page that proved too long to read sits in the tail above 8,000.
 */
const CANVAS_LENGTH_GUIDANCE_CHARS = 8000;

const DESIGN_OUTLINE_REFUSAL =
  "outline and remove_section work on reports. A design's artboards are listed in its canvas.json: " +
  "edit that file (or delete an artboard's file and its entry), then publish.";

type Refused = { error: string };

type CanvasToolResult =
  | { ok: true; canvasId: string; title: string; kind: CanvasKind; path: string; link: string; sourcePath?: string }
  | Refused;

type CanvasActionResult =
  | { ok: true; canvasId: string; path: string; title?: string; link: string }
  | Refused;

interface CanvasDeps {
  canvasStore: CanvasStore;
  sse: AgentSseEmitter;
  agentStore?: AgentStore | undefined;
}

export function buildCanvasToolPacks(input: {
  scope: AgentScope;
  agentStore?: AgentStore;
  canvasStore?: CanvasStore;
  sse?: AgentSseEmitter;
}): ToolPack[] {
  if (!input.canvasStore || !input.sse) return [];
  return [
    toolPack("canvas.interactive", [input.scope], [
      buildCanvasTool({ canvasStore: input.canvasStore, sse: input.sse, agentStore: input.agentStore }, input.scope)
    ])
  ];
}

/** One tool for every canvas action: which one is the `action` field. */
function buildCanvasTool(deps: CanvasDeps, agentScope: AgentScope): ToolDefinition<CanvasParams, unknown> {
  const workerScope = agentScope === "worker";
  return {
    name: "canvas",
    description: canvasDescription(workerScope),
    parameters: (workerScope ? workerCanvasParams : managerCanvasParams) as z.ZodType<CanvasParams>,
    handler: async (input, ctx) => {
      const misplaced = misplacedField(input);
      if (misplaced) return { error: misplaced };
      if (input.action === "create") return createCanvas(deps, input, ctx);
      const canvasId = given(input.canvasId);
      if (!canvasId) return { error: "give the canvas's id" };
      switch (input.action) {
        case "publish":
          return publishCanvas(deps, canvasId, ctx);
        case "read":
          return readCanvas(deps, canvasId, ctx);
        case "outline":
          return outlineCanvas(deps, canvasId, ctx);
        case "remove_section": {
          const index = fieldGiven(input.index) ? input.index! : null;
          if (index === null || typeof input.expectLabel !== "string") return { error: "remove_section needs index and expectLabel" };
          return removeSection(deps, canvasId, index, input.expectLabel, ctx);
        }
      }
    }
  };
}

/** The fields only create takes, and those only remove_section takes. */
const CREATE_FIELDS = ["title", "kind", "projectId"] as const;
const SECTION_FIELDS = ["index", "expectLabel"] as const;

/** A field given to an action that does not take it. A blank string or a 0
 *  is a model's way of giving nothing: not a field. */
function misplacedField(input: CanvasParams): string | null {
  const { action } = input;
  if (action === "create" && given(input.canvasId)) return "create makes a new canvas and takes no canvasId";
  if (action !== "create") {
    const field = CREATE_FIELDS.find((name) => fieldGiven(input[name]));
    if (field) return `\`${field}\` goes only with create`;
  }
  if (action !== "remove_section") {
    const field = SECTION_FIELDS.find((name) => fieldGiven(input[name]));
    if (field) return `\`${field}\` goes only with remove_section`;
  }
  return null;
}

function fieldGiven(value: string | number | undefined): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return value !== 0;
  return false;
}

/** A model fills a field it has no value for with "": that is no value. */
function given(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function createCanvas(deps: CanvasDeps, input: CanvasParams, ctx: ToolContext): CanvasToolResult {
  const title = given(input.title)?.trim();
  if (!title) return { error: "create needs a title" };
  const scope = scopeForContext(ctx);
  const canvas = deps.canvasStore.create({
    title,
    scope: scope.scope,
    scopeId: scope.scopeId,
    threadId: ctx.threadId,
    kind: input.kind || "report",
    projectId: scope.scope === "worker" ? scope.projectId : given(input.projectId) ?? null
  });
  // New artifacts are not yet in the client's list.
  deps.sse.emit(SSE_EVENTS.canvasUpdated, {
    canvasId: canvas.id,
    workerId: canvas.scope === "worker" ? canvas.scopeId : null
  });
  return canvasToolResult(canvas, canvasPath(canvas.id));
}

function readCanvas(deps: CanvasDeps, canvasId: string, ctx: ToolContext):
  | {
      canvasId: string;
      title: string;
      kind: CanvasKind;
      /** A report's published page, in characters. */
      publishedHtmlLength?: number;
      /** A design's published artboards (0 before its first publish). */
      publishedArtboards?: number;
      path: string;
      sourcePath?: string;
      updatedAt: string;
    }
  | Refused {
  const canvas = deps.canvasStore.getById(canvasId);
  if (!canvas) return { error: "canvas not found" };
  if (!canReadCanvas(canvas, ctx, deps.agentStore)) {
    return { error: "canvas is not visible from this agent scope" };
  }
  return {
    canvasId: canvas.id,
    title: canvas.title,
    kind: canvas.kind,
    ...(canvas.kind === "design"
      ? { publishedArtboards: canvas.design ? Object.keys(canvas.design.artboards).length : 0 }
      : { publishedHtmlLength: canvas.html.length }),
    path: canvasPath(canvas.id),
    sourcePath: canvas.filePath,
    updatedAt: canvas.updatedAt
  };
}

async function publishCanvas(deps: CanvasDeps, canvasId: string, ctx: ToolContext): Promise<CanvasActionResult | Record<string, unknown>> {
  const existing = deps.canvasStore.getById(canvasId);
  if (!existing) return { error: "canvas not found" };
  if (!canEditCanvas(existing, ctx, deps.agentStore)) {
    return { error: "canvas is not editable from this agent scope" };
  }
  const published = deps.canvasStore.publishSource(canvasId);
  if (published.error) return { error: published.error };
  const canvas = published.canvas!;
  const path = canvasPath(canvas.id);
  deps.sse.emit(SSE_EVENTS.canvasUpdated, {
    canvasId: canvas.id,
    workerId: canvas.scope === "worker" ? canvas.scopeId : null
  });

  if (canvas.kind === "design") {
    const artboards = Object.entries(canvas.design?.artboards ?? {});
    const warnings = [
      ...(published.warnings ?? []),
      ...artboards.flatMap(([boardPath, html]) =>
        checkCanvasPage(html, { artboard: true }).map((warning) => `${boardPath}: ${warning}`))
    ];
    return {
      ...canvasActionResult(canvas, path),
      artboards: artboards.length,
      ...(warnings.length ? { warnings } : {})
    };
  }

  // The size lands here rather than in the skill because publishing happens
  // every time content changes, while a skill is read once at the start of a
  // wake and forgotten by step 40. Until now the result carried metadata
  // only, so the author never learned how large the page it wrote was.
  const outline = await canvasOutline(canvas.html);
  const over = outline.totalChars > CANVAS_LENGTH_GUIDANCE_CHARS;
  const warnings = checkCanvasPage(canvas.html);
  return {
    ...canvasActionResult(canvas, path),
    chars: outline.totalChars,
    blocks: outline.blocks.length,
    ...(over
      ? {
          note:
            `This canvas is ${outline.totalChars} characters across ${outline.blocks.length} blocks, ` +
            `past the ~${CANVAS_LENGTH_GUIDANCE_CHARS} a reader will take in. Use outline to see ` +
            "which blocks carry the bulk, and remove_section for anything now superseded."
        }
      : {}),
    ...(warnings.length ? { warnings } : {})
  };
}

/**
 * What is in the canvas and how big each part is.
 *
 * Deciding what to cut by reading a 14 KB source costs about 4,000 input tokens
 * and re-creates the problem this is meant to solve. The outline is ~8 rows.
 */
async function outlineCanvas(deps: CanvasDeps, canvasId: string, ctx: ToolContext): Promise<unknown> {
  const existing = deps.canvasStore.getById(canvasId);
  if (!existing) return { error: "canvas not found" };
  if (!canEditCanvas(existing, ctx, deps.agentStore)) {
    return { error: "canvas is not editable from this agent scope" };
  }
  if (existing.kind === "design") return { error: DESIGN_OUTLINE_REFUSAL };
  const source = deps.canvasStore.readSource(canvasId);
  if (source.error) return { error: source.error };
  return await canvasOutline(source.content!);
}

/**
 * Remove one block, so removing costs what inserting costs.
 *
 * Without it a canvas is only ever added to: inserting anchors on any nearby
 * tag, while deleting means matching a whole block through the generic edit
 * tool and breaking the page when the match is wrong.
 */
async function removeSection(deps: CanvasDeps, canvasId: string, index: number, expectLabel: string, ctx: ToolContext): Promise<unknown> {
  const existing = deps.canvasStore.getById(canvasId);
  if (!existing) return { error: "canvas not found" };
  if (!canEditCanvas(existing, ctx, deps.agentStore)) {
    return { error: "canvas is not editable from this agent scope" };
  }
  if (existing.kind === "design") return { error: DESIGN_OUTLINE_REFUSAL };
  const source = deps.canvasStore.readSource(canvasId);
  if (source.error) return { error: source.error };

  const result = await removeCanvasBlock(source.content!, index, expectLabel);
  if (!result.ok) return { error: result.error };

  const written = deps.canvasStore.writeSource(canvasId, result.html);
  if (written.error) return { error: written.error };
  return {
    removed: result.removed,
    outline: result.outline,
    note: "source updated; publish to render it"
  };
}

function canReadCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (canvas.threadId === ctx.threadId) return true;
  if (ctx.scope.kind === "manager") return true;
  return isSameWorkerCanvas(canvas, ctx, agentStore);
}

/** Its creating thread, its worker's own thread, or a manager: a manager
 *  edits every canvas as it reads every one (a worker's report it is asked
 *  to correct need not go back to the worker). The personal agent and its
 *  side chats, whose tools have the manager's scope, read every canvas and
 *  edit their own: a thread's canvas is the thread's to change. */
function canEditCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (canvas.threadId === ctx.threadId) return true;
  if (ctx.scope.kind === "manager" && !EDITS_ONLY_ITS_OWN.has(agentStore?.getThreadById(ctx.threadId)?.scope ?? "")) return true;
  return isSameWorkerCanvas(canvas, ctx, agentStore);
}

const EDITS_ONLY_ITS_OWN: ReadonlySet<string> = new Set(["personal", "side_chat"]);

function isSameWorkerCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (ctx.scope.kind !== "worker") return false;
  if (canvas.scope !== "worker") return false;
  const workerId = ctx.worker?.id ?? agentStore?.getThreadById(ctx.threadId)?.scopeId ?? null;
  return Boolean(workerId && canvas.scopeId === workerId);
}

function scopeForContext(ctx: ToolContext): {
  scope: AgentScope;
  scopeId: string | null;
  projectId: string | null;
} {
  if (ctx.scope.kind === "worker") {
    return { scope: "worker", scopeId: ctx.worker?.id ?? null, projectId: ctx.project?.id ?? null };
  }
  return { scope: "manager", scopeId: null, projectId: null };
}

function canvasPath(id: string): string {
  return `/canvas/${encodeURIComponent(id)}`;
}

/** The canvas as a Markdown link with its title, ready for a reply: what the
 *  user reads is its name, not its path. Brackets and pipes in the title are
 *  escaped, so it stays one link, in a table too. */
function canvasLink(title: string, path: string): string {
  return `[${title.replace(/[\\[\]|]/g, (c) => `\\${c}`)}](${path})`;
}

function canvasToolResult(
  canvas: { id: string; title: string; kind: CanvasKind; filePath: string },
  path: string
): Extract<CanvasToolResult, { ok: true }> {
  return {
    ok: true,
    canvasId: canvas.id,
    title: canvas.title,
    kind: canvas.kind,
    path,
    link: canvasLink(canvas.title, path),
    sourcePath: canvas.filePath
  };
}

function canvasActionResult(
  canvas: { id: string; title: string },
  path: string
): Extract<CanvasActionResult, { ok: true }> {
  return { ok: true, canvasId: canvas.id, path, title: canvas.title, link: canvasLink(canvas.title, path) };
}
