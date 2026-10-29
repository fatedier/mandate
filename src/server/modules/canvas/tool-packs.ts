import { z } from "zod";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { AgentScope, CanvasKind } from "../../../shared/api-contracts.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { ToolContext, ToolDefinition } from "../agent/tool-registry.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { CanvasDocument, CanvasStore } from "./canvas-store.js";
import { canvasOutline, removeCanvasBlock } from "./canvas-outline.js";
import { checkCanvasPage } from "./canvas-checks.js";
import { canvasCreateDescription } from "./canvas-contract.js";

const titleParam = z.string().trim().min(1).max(120);

/**
 * Where a canvas stops being read. Set from pages that were read rather than
 * taste: a typical canvas of a few thousand visible characters reads well;
 * every page that proved too long to read sits in the tail above 8,000.
 */
const CANVAS_LENGTH_GUIDANCE_CHARS = 8000;

const DESIGN_OUTLINE_REFUSAL =
  "canvas_outline and canvas_remove_section work on reports. A design's artboards are listed in its canvas.json: " +
  "edit that file (or delete an artboard's file and its entry), then call canvas_publish.";

const createBaseParams = {
  title: titleParam.describe("The canvas's name until publish takes it from the page's <title> (a report) or canvas.json's title (a design)."),
  kind: z.enum(["report", "design"]).optional().describe(
    '"report" (default): a page to read. "design": artboards of UI screens at real sizes, to compare and choose; load the canvas-design skill first.'
  )
} satisfies z.ZodRawShape;

const featureCreateParams = z.object({
  ...createBaseParams
}).strict();

const overviewCreateParams = z.object({
  ...createBaseParams,
  projectId: z.string().min(1).optional().describe(
    "Optional project owner for manager-created canvases. Omit for a global canvas."
  )
}).strict();
type CreateParams = z.infer<typeof featureCreateParams> | z.infer<typeof overviewCreateParams>;

const updateParams = z.object({
  canvasId: z.string().min(1),
  title: titleParam.describe("New title shown in Mandate chrome.")
}).strict();

const publishParams = z.object({
  canvasId: z.string().min(1)
}).strict();

const readParams = z.object({
  canvasId: z.string().min(1)
}).strict();

type CanvasToolResult =
  | { ok: true; canvasId: string; title: string; kind: CanvasKind; path: string; link: string; sourcePath?: string }
  | { error: string };

type CanvasActionResult =
  | { ok: true; canvasId: string; path: string; title?: string; link: string }
  | { error: string };

export function buildCanvasToolPacks(input: {
  scope: AgentScope;
  agentStore?: AgentStore;
  canvasStore?: CanvasStore;
  sse?: AgentSseEmitter;
}): ToolPack[] {
  if (!input.canvasStore || !input.sse) return [];
  return [
    toolPack(
      "canvas.interactive",
      [input.scope],
      [
        buildCanvasCreateTool(input.canvasStore, input.sse, input.scope),
        buildCanvasReadTool(input.canvasStore, input.agentStore),
        buildCanvasUpdateTool(input.canvasStore, input.sse, input.agentStore),
        buildCanvasPublishTool(input.canvasStore, input.sse, input.agentStore),
        buildCanvasOutlineTool(input.canvasStore, input.agentStore),
        buildCanvasRemoveSectionTool(input.canvasStore, input.agentStore)
      ]
    )
  ];
}

type CanvasToolResultExt = Extract<CanvasToolResult, { ok: true }> & { warning?: string };

function buildCanvasCreateTool(
  canvasStore: CanvasStore,
  sse?: AgentSseEmitter,
  agentScope?: AgentScope
): ToolDefinition<CreateParams, CanvasToolResultExt | { error: string }> {
  const featureScope = agentScope === "worker";
  return {
    name: "canvas_create",
    description: canvasCreateDescription(featureScope),
    parameters: (featureScope ? featureCreateParams : overviewCreateParams) as z.ZodType<CreateParams>,
    handler: async (args, ctx) => {
      const scope = scopeForContext(ctx);
      const canvas = canvasStore.create({
        title: args.title,
        scope: scope.scope,
        scopeId: scope.scopeId,
        threadId: ctx.threadId,
        kind: args.kind ?? "report",
        projectId: scope.scope === "worker"
          ? scope.projectId
          : "projectId" in args ? args.projectId ?? null : null
      });
      const path = canvasPath(canvas.id);
      const base = canvasToolResult(canvas, path);
      // New artifacts are not yet in the client's list.
      sse?.emit(SSE_EVENTS.canvasUpdated, {
        canvasId: canvas.id,
        featureId: canvas.scope === "worker" ? canvas.scopeId : null
      });
      return base;
    }
  };
}

function buildCanvasReadTool(
  canvasStore: CanvasStore,
  agentStore?: AgentStore
): ToolDefinition<
  z.infer<typeof readParams>,
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
  | { error: string }
> {
  return {
    name: "canvas_read",
    description:
      "Read metadata for an existing canvas visible to this agent scope. " +
      "The manager can inspect all canvases; workers can inspect their feature's canvases. " +
      "This does not return HTML; use read on sourcePath to inspect the editable source file.",
    parameters: readParams,
    handler: async (args, ctx) => {
      const canvas = canvasStore.getById(args.canvasId);
      if (!canvas) return { error: "canvas not found" };
      if (!canReadCanvas(canvas, ctx, agentStore)) {
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
  };
}

function buildCanvasUpdateTool(
  canvasStore: CanvasStore,
  sse: AgentSseEmitter,
  agentStore?: AgentStore
): ToolDefinition<z.infer<typeof updateParams>, CanvasActionResult> {
  return {
    name: "canvas_update",
    description:
      "Rename an editable canvas. The creating thread can edit its canvas; " +
      "a feature's main agent thread can edit canvases bound to that feature; a manager can edit any canvas. " +
      "A rename here lasts only until the next publish that finds a title: " +
      "every canvas_publish takes the title from the page's <title> when there is one, and a design's from canvas.json's title when there is one. " +
      "So to rename for good, change it there and publish. " +
      "To change canvas content, edit sourcePath with the normal file tools and call canvas_publish.",
    parameters: updateParams,
    handler: async (args, ctx) => {
      const existing = canvasStore.getById(args.canvasId);
      if (!existing) return { error: "canvas not found" };
      if (!canEditCanvas(existing, ctx, agentStore)) {
        return { error: "canvas is not editable from this agent scope" };
      }
      const canvas = canvasStore.update({
        id: args.canvasId,
        title: args.title
      });
      if (!canvas) return { error: "canvas not found" };
      const path = canvasPath(canvas.id);
      sse.emit(SSE_EVENTS.canvasUpdated, {
        canvasId: canvas.id,
        featureId: canvas.scope === "worker" ? canvas.scopeId : null
      });
      return canvasActionResult(canvas, path);
    }
  };
}

function buildCanvasPublishTool(
  canvasStore: CanvasStore,
  sse: AgentSseEmitter,
  agentStore?: AgentStore
): ToolDefinition<z.infer<typeof publishParams>, CanvasActionResult> {
  return {
    name: "canvas_publish",
    description:
      "Publish an editable canvas source file after editing it with read/edit/write. " +
      "The creating thread can publish its canvas; a feature's main agent thread can " +
      "publish canvases bound to that feature; a manager can publish any canvas. Reads index.html and refreshes the rendered canvas shown in Mandate. " +
      "Returns warnings for problems it can see in the page (a report's missing <title>, a blocked host, no body background, a report's token defined only in dark); fix them and publish again. " +
      "A page over 16 MB is refused. " +
      "For a design, it reads canvas.json and every artboard it lists, and refuses a missing file or an index it cannot read.",
    parameters: publishParams,
    handler: async (args, ctx) => {
      const existing = canvasStore.getById(args.canvasId);
      if (!existing) return { error: "canvas not found" };
      if (!canEditCanvas(existing, ctx, agentStore)) {
        return { error: "canvas is not editable from this agent scope" };
      }
      const published = canvasStore.publishSource(args.canvasId);
      if (published.error) return { error: published.error };
      const canvas = published.canvas!;
      const path = canvasPath(canvas.id);
      sse.emit(SSE_EVENTS.canvasUpdated, {
        canvasId: canvas.id,
        featureId: canvas.scope === "worker" ? canvas.scopeId : null
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
                `past the ~${CANVAS_LENGTH_GUIDANCE_CHARS} a reader will take in. Use canvas_outline to see ` +
                "which blocks carry the bulk, and canvas_remove_section for anything now superseded."
            }
          : {}),
        ...(warnings.length ? { warnings } : {})
      };
    }
  };
}

const outlineParams = z.object({
  canvasId: z.string().min(1)
});

const removeSectionParams = z.object({
  canvasId: z.string().min(1),
  index: z.number().int().positive().describe(
    "Block position from canvas_outline. Positions shift as soon as anything is removed."
  ),
  expectLabel: z.string().describe(
    "The label canvas_outline reported for that position. The removal is refused if it no longer matches."
  )
});

/**
 * What is in the canvas and how big each part is.
 *
 * Deciding what to cut by reading a 14 KB source costs about 4,000 input tokens
 * and re-creates the problem this is meant to solve. The outline is ~8 rows.
 */
function buildCanvasOutlineTool(
  canvasStore: CanvasStore,
  agentStore?: AgentStore
): ToolDefinition<z.infer<typeof outlineParams>, unknown> {
  return {
    name: "canvas_outline",
    description:
      "List a canvas's top-level blocks with their labels and visible character counts, " +
      "without reading the whole file. Use before canvas_remove_section, and to see which " +
      "part of a long canvas is carrying the bulk.",
    parameters: outlineParams,
    handler: async (args, ctx) => {
      const existing = canvasStore.getById(args.canvasId);
      if (!existing) return { error: "canvas not found" };
      if (!canEditCanvas(existing, ctx, agentStore)) {
        return { error: "canvas is not editable from this agent scope" };
      }
      if (existing.kind === "design") return { error: DESIGN_OUTLINE_REFUSAL };
      const source = canvasStore.readSource(args.canvasId);
      if (source.error) return { error: source.error };
      return await canvasOutline(source.content!);
    }
  };
}

/**
 * Remove one block, so removing costs what inserting costs.
 *
 * Without it a canvas is only ever added to: inserting anchors on any nearby
 * tag, while deleting means matching a whole block through the generic edit
 * tool and breaking the page when the match is wrong.
 */
function buildCanvasRemoveSectionTool(
  canvasStore: CanvasStore,
  agentStore?: AgentStore
): ToolDefinition<z.infer<typeof removeSectionParams>, unknown> {
  return {
    name: "canvas_remove_section",
    description:
      "Remove one top-level block from a canvas's source, by its canvas_outline position. " +
      "Pass the label that position reported; the removal is refused if it has moved. " +
      "Edits the source file — call canvas_publish afterwards, once, for any number of removals.",
    parameters: removeSectionParams,
    handler: async (args, ctx) => {
      const existing = canvasStore.getById(args.canvasId);
      if (!existing) return { error: "canvas not found" };
      if (!canEditCanvas(existing, ctx, agentStore)) {
        return { error: "canvas is not editable from this agent scope" };
      }
      if (existing.kind === "design") return { error: DESIGN_OUTLINE_REFUSAL };
      const source = canvasStore.readSource(args.canvasId);
      if (source.error) return { error: source.error };

      const result = await removeCanvasBlock(source.content!, args.index, args.expectLabel);
      if (!result.ok) return { error: result.error };

      const written = canvasStore.writeSource(args.canvasId, result.html);
      if (written.error) return { error: written.error };
      return {
        removed: result.removed,
        outline: result.outline,
        note: "source updated; call canvas_publish to render it"
      };
    }
  };
}

function canReadCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (canvas.threadId === ctx.threadId) return true;
  if (ctx.scope.kind === "manager") return true;
  return isSameFeatureCanvas(canvas, ctx, agentStore);
}

/** Its creating thread, a worker of its feature, or a manager: a manager
 *  edits every canvas as it reads every one (a worker's report it is asked
 *  to correct need not go back to the worker). Your agent has no canvas
 *  tools. */
function canEditCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (canvas.threadId === ctx.threadId) return true;
  if (ctx.scope.kind === "manager") return true;
  return isSameFeatureCanvas(canvas, ctx, agentStore);
}

function isSameFeatureCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (ctx.scope.kind !== "worker") return false;
  if (canvas.scope !== "worker") return false;
  const featureId = ctx.feature?.id ?? agentStore?.getThreadById(ctx.threadId)?.scopeId ?? null;
  return Boolean(featureId && canvas.scopeId === featureId);
}

function scopeForContext(ctx: ToolContext): {
  scope: AgentScope;
  scopeId: string | null;
  projectId: string | null;
} {
  if (ctx.scope.kind === "worker") {
    return { scope: "worker", scopeId: ctx.feature?.id ?? null, projectId: ctx.project?.id ?? null };
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
