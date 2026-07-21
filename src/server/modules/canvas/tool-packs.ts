import { z } from "zod";
import { SSE_EVENTS, UI_ACTIONS } from "../../../shared/api-contracts.js";
import type { AgentScope, CanvasKind } from "../../../shared/api-contracts.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { ToolContext, ToolDefinition } from "../agent/tool-registry.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { CanvasDocument, CanvasStore } from "./canvas-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import { toWorkItemDto } from "../agent/work-item-dto.js";
import { canvasOutline, removeCanvasBlock } from "./canvas-outline.js";

const titleParam = z.string().trim().min(1).max(120);

/**
 * Where a canvas stops being read. Set from the corpus rather than taste: across
 * 97 canvases the median is 2,496 visible characters and those draw no
 * complaint; every page the user has objected to sits in the tail above 8,000.
 */
const CANVAS_LENGTH_GUIDANCE_CHARS = 8000;

const createBaseParams = {
  title: titleParam.describe("Short title shown in Mandate chrome."),
} satisfies z.ZodRawShape;

const featureCreateParams = z.object({
  ...createBaseParams,
  bindToFeature: z.boolean().optional().describe(
    "When true, automatically bind this canvas to the feature's work_item — UI surfaces it as the feature's primary dashboard."
  )
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

const openParams = z.object({
  canvasId: z.string().min(1)
}).strict();

const publishParams = z.object({
  canvasId: z.string().min(1)
}).strict();

const readParams = z.object({
  canvasId: z.string().min(1)
}).strict();

type CanvasToolResult =
  | { ok: true; canvasId: string; title: string; kind: CanvasKind; path: string; sourcePath?: string }
  | { error: string };

type CanvasActionResult =
  | { ok: true; canvasId: string; path: string; title?: string }
  | { error: string };

export function buildCanvasToolPacks(input: {
  scope: AgentScope;
  agentStore?: AgentStore;
  canvasStore?: CanvasStore;
  sse?: AgentSseEmitter;
  workStore?: WorkItemStore;
}): ToolPack[] {
  if (!input.canvasStore || !input.sse) return [];
  return [
    toolPack(
      "canvas.interactive",
      [input.scope],
      [
        buildCanvasCreateTool(input.canvasStore, input.workStore, input.sse, input.scope),
        buildCanvasReadTool(input.canvasStore, input.agentStore),
        buildCanvasUpdateTool(input.canvasStore, input.sse, input.agentStore),
        buildCanvasPublishTool(input.canvasStore, input.sse, input.agentStore),
        buildCanvasOutlineTool(input.canvasStore, input.agentStore),
        buildCanvasRemoveSectionTool(input.canvasStore, input.agentStore),
        buildCanvasOpenTool(input.canvasStore, input.sse)
      ]
    )
  ];
}

type CanvasToolResultExt = Extract<CanvasToolResult, { ok: true }> & { warning?: string };

function buildCanvasCreateTool(
  canvasStore: CanvasStore,
  workStore?: WorkItemStore,
  sse?: AgentSseEmitter,
  agentScope?: AgentScope
): ToolDefinition<CreateParams, CanvasToolResultExt | { error: string }> {
  const featureScope = agentScope === "worker";
  return {
    name: "canvas_create",
    description:
      "Create a canvas (visual HTML page) and return its canvasId/title/path/sourcePath. " +
      "Write a complete HTML document (<!doctype html>...) to the returned sourcePath, " +
      "then call canvas_publish. Mandate renders it inside a sandboxed iframe; " +
      "Tailwind classes work out of the box and the iframe sizes itself to body height. " +
      "Canvas is a shipped product surface — reference high-end SaaS product UI (Linear, Vercel, Stripe quality), not an admin dashboard or status report. " +
      "Conclusion first; visual weight tracks hierarchy. " +
      "You own the whole design: it is a self-contained page in its own iframe, not app chrome. Set your own dark background and a real palette (gradients, colored rings, accent text, shadows). " +
      "Do NOT use Mandate theme tokens (`bg-card`, `bg-background`, `border-border`, `text-muted-foreground`) — they render flat near-gray; pick concrete colors. " +
      "No fake controls or placeholder copy. " +
      "This tool does not accept content directly. " +
      (featureScope
        ? "Pass bindToFeature=true to make this canvas the feature's primary dashboard (UI shows 📊 icon + Canvas tab). This tool does not accept projectId; the feature's project is applied automatically."
        : "Optionally pass projectId to store the canvas under a project; omit projectId for a global canvas."),
    parameters: (featureScope ? featureCreateParams : overviewCreateParams) as z.ZodType<CreateParams>,
    approval: "never",
    handler: async (args, ctx) => {
      const scope = scopeForContext(ctx);
      const canvas = canvasStore.create({
        title: args.title,
        scope: scope.scope,
        scopeId: scope.scopeId,
        threadId: ctx.threadId,
        projectId: scope.scope === "worker"
          ? scope.projectId
          : "projectId" in args ? args.projectId ?? null : null
      });
      const path = canvasPath(canvas.id);
      const base = canvasToolResult(canvas, path);
      // New artifacts are not yet in the client's list, including unbound ones.
      sse?.emit(SSE_EVENTS.canvasUpdated, {
        canvasId: canvas.id,
        featureId: canvas.scope === "worker" ? canvas.scopeId : null
      });
      const bindToFeature = "bindToFeature" in args ? args.bindToFeature : false;
      if (!bindToFeature) return base;
      if (scope.scope !== "worker") {
        return { ...base, warning: "bindToFeature is only valid for feature-scope canvases; ignored." };
      }
      if (!workStore) {
        // Defensive: tool was built without workStore. Should not happen in production.
        return { ...base, warning: "bindToFeature requested but workStore not configured; canvas not bound." };
      }
      const ok = workStore.setCanvasIdForFeature(scope.scopeId!, canvas.id);
      if (!ok) {
        return { ...base, warning: "bindToFeature requested but this feature has no work_item; canvas created but not bound." };
      }
      // Emit SSE so client store refreshes canvasId on this work_item.
      if (sse) {
        const updated = workStore.getByFeature(scope.scopeId!);
        if (updated) sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(updated) });
      }
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
      publishedHtmlLength: number;
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
    approval: "never",
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
        publishedHtmlLength: canvas.html.length,
        path: canvasPath(canvas.id),
        ...(canvas.filePath ? { sourcePath: canvas.filePath } : {}),
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
      "a feature's main agent thread can edit canvases bound to that feature. " +
      "To change canvas content, edit sourcePath with the normal file tools and call canvas_publish.",
    parameters: updateParams,
    approval: "never",
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
      return canvasActionResult(canvas, path, { includeTitle: true });
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
      "publish canvases bound to that feature. Reads index.html and refreshes the rendered canvas shown in Mandate.",
    parameters: publishParams,
    approval: "never",
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

      // The size lands here rather than in the skill because publishing happens
      // every time content changes, while a skill is read once at the start of a
      // wake and forgotten by step 40. Until now the result carried metadata
      // only, so the author never learned how large the page it wrote was.
      const outline = await canvasOutline(canvas.html);
      const over = outline.totalChars > CANVAS_LENGTH_GUIDANCE_CHARS;
      return {
        ...canvasActionResult(canvas, path, { includeTitle: true }),
        chars: outline.totalChars,
        blocks: outline.blocks.length,
        ...(over
          ? {
              note:
                `This canvas is ${outline.totalChars} characters across ${outline.blocks.length} blocks, ` +
                `past the ~${CANVAS_LENGTH_GUIDANCE_CHARS} a reader will take in. Use canvas_outline to see ` +
                "which blocks carry the bulk, and canvas_remove_section for anything now superseded."
            }
          : {})
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
    approval: "never",
    handler: async (args, ctx) => {
      const existing = canvasStore.getById(args.canvasId);
      if (!existing) return { error: "canvas not found" };
      if (!canEditCanvas(existing, ctx, agentStore)) {
        return { error: "canvas is not editable from this agent scope" };
      }
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
    approval: "never",
    handler: async (args, ctx) => {
      const existing = canvasStore.getById(args.canvasId);
      if (!existing) return { error: "canvas not found" };
      if (!canEditCanvas(existing, ctx, agentStore)) {
        return { error: "canvas is not editable from this agent scope" };
      }
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

function buildCanvasOpenTool(
  canvasStore: CanvasStore,
  sse: AgentSseEmitter
): ToolDefinition<z.infer<typeof openParams>, CanvasActionResult> {
  return {
    name: "canvas_open",
    description: "Open an existing canvas in the user's main Mandate content area.",
    parameters: openParams,
    approval: "never",
    handler: async ({ canvasId }) => {
      const canvas = canvasStore.getById(canvasId);
      if (!canvas) return { error: "canvas not found" };
      const path = canvasPath(canvas.id);
      openCanvas(sse, path);
      return canvasActionResult(canvas, path);
    }
  };
}

function canReadCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (canvas.threadId === ctx.threadId) return true;
  if (ctx.scope.kind === "manager") return true;
  return isSameFeatureCanvas(canvas, ctx, agentStore);
}

function canEditCanvas(canvas: CanvasDocument, ctx: ToolContext, agentStore?: AgentStore): boolean {
  if (canvas.threadId === ctx.threadId) return true;
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

function openCanvas(sse: AgentSseEmitter, path: string): void {
  sse.emit(SSE_EVENTS.agentUiAction, {
    action: UI_ACTIONS.navigate,
    payload: { path }
  });
}

function canvasToolResult(
  canvas: { id: string; title: string; kind: CanvasKind; filePath?: string | null },
  path: string
): Extract<CanvasToolResult, { ok: true }> {
  return {
    ok: true,
    canvasId: canvas.id,
    title: canvas.title,
    kind: canvas.kind,
    path,
    ...(canvas.filePath ? { sourcePath: canvas.filePath } : {})
  };
}

function canvasActionResult(
  canvas: { id: string; title: string },
  path: string,
  options: { includeTitle?: boolean } = {}
): Extract<CanvasActionResult, { ok: true }> {
  return {
    ok: true,
    canvasId: canvas.id,
    path,
    ...(options.includeTitle ? { title: canvas.title } : {})
  };
}
