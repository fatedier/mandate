import { z } from "zod";
import { tool as aiTool, type Tool, type ToolSet } from "ai";
import type { AgentScope as AgentToolScope } from "./tool-scope.js";
import type { FeatureRow } from "../features/features-store.js";
import type { ProjectRow } from "../projects/projects-store.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { Analyzer } from "../analysis/analyzer.js";
import type { PaneMetadataStore } from "../panes/pane-metadata-store.js";
import type { TmuxRuntime } from "../../runtime/runtimes/tmux-runtime.js";
import { maybeSpoolToolResult } from "./tool-output-spool.js";
import { errorText } from "../../../shared/error-text.js";

export interface ToolContext {
  threadId: string;
  wakeId: string;
  scope: AgentToolScope;
  feature?: FeatureRow;
  project?: ProjectRow;
  tmuxClient?: TmuxClient;
  analyzer?: Analyzer;
  paneRuntime?: TmuxRuntime;
  paneMetadata?: PaneMetadataStore;
  /** Aborts when the turn is stopped: a tool that runs long (bash) stops on
   *  it and throws TOOL_CALL_STOPPED. */
  signal?: AbortSignal;
}

/** What a call the turn's stop reached says: one stopped while it ran, and
 *  each one after it, which never ran. */
export const TOOL_CALL_STOPPED = "Stopped by user.";

export interface ToolDefinition<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  handler: {
    bivarianceHack(args: TParams, ctx: ToolContext): Promise<TResult>;
  }["bivarianceHack"];
  /** Whether the tool is offered now. Read at every model step, so a tool
   *  that rests on a setting comes and goes with it. Absent: always. */
  available?: () => boolean;
}

export type RegisteredToolDefinition = Omit<ToolDefinition<unknown, unknown>, "parameters"> & {
  parameters: z.ZodType<unknown>;
};

export type FeatureToolContext = ToolContext & {
  feature: FeatureRow;
  project: ProjectRow;
  paneRuntime: TmuxRuntime;
  paneMetadata?: PaneMetadataStore;
  analyzer?: Analyzer;
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
  private allTools: ToolSet = {};
  /** The last set handed out, with the names it holds: the same object
   *  while nothing comes or goes. */
  private offered: { names: string; tools: ToolSet } | null = null;

  register<P, R>(def: ToolDefinition<P, R>): void {
    this.defs.set(def.name, {
      name: def.name,
      description: def.description,
      parameters: def.parameters as z.ZodType<unknown>,
      handler: (args, ctx) => def.handler(args as P, ctx),
      ...(def.available ? { available: def.available } : {})
    });
    this.offered = null;
    // The AI SDK `tool()` helper builds the Tool object that streamText/generateText consume.
    // Do NOT define execute: our wake-loop calls ToolDispatcher.dispatch manually.
    // If execute were defined, AI SDK would call it automatically from the stream
    // processing AND our loop would dispatch again — causing double execution.
    // Field name is `inputSchema` in current AI SDK versions. Without it
    // the LLM provider receives `type: "None"` for the tool's args schema and rejects
    // the call (e.g. OpenAI: "Invalid schema for function 'X'").
    // `strict: false`, said: the OpenAI Responses API makes a tool that omits
    // it strict where it can, and strict requires every property, so the model
    // fills every optional one (memory_read's mutually exclusive id, project
    // and scope fail that way).
    this.allTools[def.name] = aiTool({
      description: def.description,
      inputSchema: def.parameters,
      strict: false,
    }) as Tool;
  }

  /** The tools offered now, in registration order. */
  get tools(): ToolSet {
    const names = this.definitions.map((def) => def.name);
    const key = names.join("\n");
    if (this.offered?.names === key) return this.offered.tools;
    const tools: ToolSet = {};
    for (const name of names) tools[name] = this.allTools[name]!;
    this.offered = { names: key, tools };
    return tools;
  }

  /** A tool that is offered now; null for one that is not, which dispatch
   *  answers as an unknown tool. */
  getDefinition(name: string): RegisteredToolDefinition | null {
    const def = this.defs.get(name);
    return def && isAvailable(def) ? def : null;
  }

  /** The ToolDefinitions offered now, in registration order. */
  get definitions(): RegisteredToolDefinition[] {
    return Array.from(this.defs.values()).filter(isAvailable);
  }
}

function isAvailable(def: RegisteredToolDefinition): boolean {
  return def.available?.() !== false;
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
      const msg = errorText(err);
      return { isError: true, error: msg };
    }
  }
}
