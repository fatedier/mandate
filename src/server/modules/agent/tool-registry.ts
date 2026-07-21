import { z } from "zod";
import { tool as aiTool, type Tool, type ToolSet } from "ai";
import type { AgentScope as AgentToolScope } from "./tool-scope.js";
import type { FeatureRow } from "../features/features-store.js";
import type { ProjectRow } from "../projects/projects-store.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { Analyzer } from "../analysis/analyzer.js";
import type { PaneMetadataStore } from "../panes/pane-metadata-store.js";
import type { PaneRuntime } from "../../runtime/pane-runtime.js";
import type { PaneAnalysis } from "../../platform/tmux/tmux-types.js";
import { maybeSpoolToolResult } from "./tool-output-spool.js";

type ToolApproval = "never" | "always" | "first-use";

export interface ToolContext {
  threadId: string;
  /** Main-thread lineage for shared task and memory state. Equals threadId for main threads. */
  lineageThreadId?: string;
  wakeId: string;
  scope: AgentToolScope;
  feature?: FeatureRow;
  project?: ProjectRow;
  tmuxClient?: TmuxClient;
  analyzer?: Analyzer;
  paneRuntime?: PaneRuntime;
  paneMetadata?: PaneMetadataStore;
}

export interface ToolDefinition<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  approval: ToolApproval;
  handler: {
    bivarianceHack(args: TParams, ctx: ToolContext): Promise<TResult>;
  }["bivarianceHack"];
}

export type RegisteredToolDefinition = Omit<ToolDefinition<unknown, unknown>, "parameters"> & {
  parameters: z.ZodType<unknown>;
};

export type FeatureToolContext = ToolContext & {
  feature: FeatureRow;
  project: ProjectRow;
  paneRuntime: PaneRuntime;
  paneMetadata?: PaneMetadataStore;
  analyzer?: Analyzer & { getCachedAnalysis?: (paneId: string) => PaneAnalysis | null };
  tmuxClient?: TmuxClient;
};

export function requireFeatureToolContext(ctx: ToolContext): FeatureToolContext {
  if (!ctx.feature || !ctx.project || !ctx.paneRuntime) {
    throw new Error("feature tool context is incomplete");
  }
  return ctx as FeatureToolContext;
}

export class ToolRegistry {
  private defs = new Map<string, RegisteredToolDefinition>();
  tools: ToolSet = {};

  register<P, R>(def: ToolDefinition<P, R>): void {
    this.defs.set(def.name, {
      name: def.name,
      description: def.description,
      parameters: def.parameters as z.ZodType<unknown>,
      approval: def.approval,
      handler: (args, ctx) => def.handler(args as P, ctx)
    });
    // The AI SDK `tool()` helper builds the Tool object that streamText/generateText consume.
    // Do NOT define execute: our wake-loop calls ToolDispatcher.dispatch manually.
    // If execute were defined, AI SDK would call it automatically from the stream
    // processing AND our loop would dispatch again — causing double execution.
    // Field name is `inputSchema` in current AI SDK versions. Without it
    // the LLM provider receives `type: "None"` for the tool's args schema and rejects
    // the call (e.g. OpenAI: "Invalid schema for function 'X'").
    this.tools[def.name] = aiTool({
      description: def.description,
      inputSchema: def.parameters,
    }) as Tool;
  }

  getDefinition(name: string): RegisteredToolDefinition | null {
    return this.defs.get(name) ?? null;
  }

  /** All registered ToolDefinitions in registration order. */
  get definitions(): RegisteredToolDefinition[] {
    return Array.from(this.defs.values());
  }
}

interface DispatchedToolResult {
  result?: unknown;
  isError?: boolean;
  error?: string;
}

export class ToolDispatcher {
  constructor(public registry: ToolRegistry) {}

  async dispatch(
    call: { toolCallId: string; toolName: string; args: unknown },
    ctx: ToolContext
  ): Promise<DispatchedToolResult> {
    const def = this.registry.getDefinition(call.toolName);
    if (!def) return { isError: true, error: `unknown tool: ${call.toolName}` };

    const parsed = def.parameters.safeParse(call.args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => {
          const path = i.path.join(".");
          return path ? `${path}: ${i.message}` : i.message;
        })
        .join("; ");
      return { isError: true, error: `parameter validation failed: ${issues}` };
    }
    try {
      const result = await def.handler(parsed.data, ctx);
      return {
        result: maybeSpoolToolResult({
          result,
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          threadId: ctx.threadId,
          wakeId: ctx.wakeId,
          owner: ctx.project ? { kind: "project", projectId: ctx.project.id } : { kind: "global" }
        })
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, error: msg };
    }
  }
}
