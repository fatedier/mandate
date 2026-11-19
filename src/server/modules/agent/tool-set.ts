import type { z } from "zod";
import { asSchema, tool as aiTool, type Tool, type ToolSet } from "ai";

/** A tool as a model call offers it, by name, description and the catalog
 *  key of its input schema (tool-schema-catalog.ts): what another thread
 *  needs to offer the same tool. */
export interface OfferedToolSpec {
  name: string;
  description: string;
  schemaKey: string;
}

/** The AI SDK's tool for a definition. No execute: the wake loop dispatches
 *  each call itself (ToolDispatcher); with one, the SDK would run it too.
 *  `strict: false`, said: the OpenAI Responses API makes a tool that omits it
 *  strict where it can, and strict requires every property, so the model
 *  fills every optional one (memory_read's mutually exclusive id, project and
 *  scope fail that way). Its schema as a schema object made once: the SDK
 *  turns a bare zod schema into JSON Schema again for every request. */
export function sdkTool(description: string, schema: z.ZodType<unknown>): Tool {
  return aiTool({
    description,
    inputSchema: asSchema(schema),
    strict: false,
  }) as Tool;
}

/** The tool set for these specs, built as ToolRegistry builds its own. */
export function buildToolSet(specs: OfferedToolSpec[], schemas: Readonly<Record<string, z.ZodType<unknown>>>): ToolSet {
  const tools: ToolSet = {};
  for (const spec of specs) {
    const schema = schemas[spec.schemaKey];
    if (!schema) throw new Error(`no tool schema ${spec.schemaKey}`);
    tools[spec.name] = sdkTool(spec.description, schema);
  }
  return tools;
}
