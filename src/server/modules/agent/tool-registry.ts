import { z } from "zod";
import type { ToolSet } from "ai";
import type { AgentScope as AgentToolScope } from "./tool-scope.js";
import type { WorkerRow } from "../workers/workers-store.js";
import type { ProjectRow } from "../projects/projects-store.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { Analyzer } from "../analysis/analyzer.js";
import type { PaneMetadataStore } from "../panes/pane-metadata-store.js";
import type { TmuxRuntime } from "../../runtime/runtimes/tmux-runtime.js";
import { maybeSpoolToolResult } from "./tool-output-spool.js";
import { errorText } from "../../../shared/error-text.js";
import { stallWatch } from "../../platform/diagnostics/stall-watch.js";
import { toolSchemaKey } from "./tool-schema-catalog.js";
import { sdkTool, type OfferedToolSpec } from "./tool-set.js";

export type { OfferedToolSpec } from "./tool-set.js";

export interface ToolContext {
  threadId: string;
  wakeId: string;
  scope: AgentToolScope;
  worker?: WorkerRow;
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
  /** Its schema's key in the catalog (tool-schema-catalog.ts), when it is one of the catalog's. */
  schemaKey?: string;
};

export type WorkerToolContext = ToolContext & {
  worker: WorkerRow;
  project: ProjectRow;
  paneRuntime: TmuxRuntime;
  paneMetadata?: PaneMetadataStore;
  analyzer?: Analyzer;
  tmuxClient?: TmuxClient;
};

export function requireWorkerToolContext(ctx: ToolContext): WorkerToolContext {
  if (!ctx.worker || !ctx.project || !ctx.paneRuntime) {
    throw new Error("worker tool context is incomplete");
  }
  return ctx as WorkerToolContext;
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
      ...(def.available ? { available: def.available } : {}),
      ...withSchemaKey(def.parameters as z.ZodType<unknown>)
    });
    this.offered = null;
    this.allTools[def.name] = sdkTool(def.description, def.parameters as z.ZodType<unknown>);
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

  /** The tools offered now as specs, in the order of `tools`; null when one
   *  of them has a schema the catalog does not hold. */
  offeredSpecs(): OfferedToolSpec[] | null {
    const specs: OfferedToolSpec[] = [];
    for (const def of this.definitions) {
      if (!def.schemaKey) return null;
      specs.push({ name: def.name, description: def.description, schemaKey: def.schemaKey });
    }
    return specs;
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

function withSchemaKey(schema: z.ZodType<unknown>): { schemaKey?: string } {
  const schemaKey = toolSchemaKey(schema);
  return schemaKey ? { schemaKey } : {};
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
      const result = await stallWatch.watched(`tool ${call.toolName}`, () => def.handler(parsed.data, ctx));
      return {
        result: stallWatch.run(`tool ${call.toolName} result file`, () => maybeSpoolToolResult({
          result,
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          threadId: ctx.threadId,
          wakeId: ctx.wakeId,
          owner: ctx.project ? { kind: "project", projectId: ctx.project.id } : { kind: "global" }
        }))
      };
    } catch (err) {
      const msg = errorText(err);
      return { isError: true, error: msg };
    }
  }
}
