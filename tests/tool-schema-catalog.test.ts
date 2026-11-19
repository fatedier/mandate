import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Tool, ToolSet } from "ai";
import type { ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { buildToolSet } from "../src/server/modules/agent/tool-set.js";
import { TOOL_INPUT_SCHEMAS } from "../src/server/modules/agent/tool-schema-catalog.js";
import { openAttemptStreamState, streamModelOnce } from "../src/server/modules/agent/model-stream.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { createScriptedStreamLLM } from "./helpers/mock-llm.js";

// Every tool's input schema lives in a schema-only module, gathered in one
// catalog, so another thread can offer the same tools and validate a model's
// calls exactly as this thread does.

const SRC = path.resolve(import.meta.dir, "../src/server");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);

/** The identifiers a `parameters:` value names: a constant, a cast of one,
 *  or a choice between two. Anything else (an inline schema, a call) is null. */
function namedSchemas(node: ts.Expression): string[] | null {
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return namedSchemas(node.expression);
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const a = namedSchemas(node.whenTrue); const b = namedSchemas(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

test("every tool definition takes its input schema from a schema-only module", () => {
  const problems: string[] = [];
  let definitions = 0;
  // The registry's own register() builds such an object from what it was given.
  for (const file of files(SRC).filter((f) => !f.endsWith("tool-registry.ts"))) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const importedFrom = new Map<string, string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
      for (const el of st.importClause.namedBindings.elements) importedFrom.set(el.name.text, (st.moduleSpecifier as ts.StringLiteral).text);
    }
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map(node.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(), p]));
        const handler = node.properties.some((p) => p.name?.getText() === "handler");
        const parameters = props.get("parameters");
        if (parameters && handler && props.has("name")) {
          definitions += 1;
          const where = `${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(parameters.getStart()).line + 1}`;
          const names = namedSchemas(parameters.initializer);
          if (!names) problems.push(`${where} is not a named schema`);
          else for (const name of names) if (!importedFrom.get(name)?.endsWith("-schema.js")) problems.push(`${where}: ${name} is not imported from a -schema module`);
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  expect(definitions).toBeGreaterThan(60);
  expect(problems).toEqual([]);
});

test("the catalog's modules reach no package but zod", () => {
  const catalog = path.join(SRC, "modules/agent/tool-schema-catalog.ts");
  const seen = new Set<string>();
  const outside: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) && !(ts.isExportDeclaration(st) && st.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) continue;
      const spec = ((st as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text;
      if (spec === "zod") continue;
      if (!spec.startsWith(".")) { outside.push(`${path.relative(SRC, file)} imports ${spec}`); continue; }
      walk(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  walk(catalog);
  expect(outside).toEqual([]);
  expect(seen.size).toBeGreaterThan(40);
});

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

function scopeRegistries() {
  const env = freshStoresEnv("md-tool-catalog-");
  const runtime = testAgentRuntime(env);
  cleanup = () => { runtime.dispose(); env.cleanup(); };
  return (["manager", "worker", "personal", "subagent"] as const).map((scope) => [scope, runtime.scopes[scope].wrappedDispatcher.registry as unknown as ToolRegistry] as const);
}

const toolShape = async (tool: Tool) => ({
  description: tool.description,
  strict: (tool as { strict?: boolean }).strict,
  schema: JSON.stringify(await (tool.inputSchema as { jsonSchema: unknown }).jsonSchema)
});

test("every scope's tools have catalog keys, and the catalog builds the same tools", async () => {
  for (const [scope, registry] of scopeRegistries()) {
    const specs = registry.offeredSpecs();
    expect([scope, specs === null]).toEqual([scope, false]);
    const rebuilt = buildToolSet(specs!, TOOL_INPUT_SCHEMAS);
    expect(Object.keys(rebuilt)).toEqual(Object.keys(registry.tools));
    for (const name of Object.keys(registry.tools)) {
      expect([scope, name, await toolShape(rebuilt[name]!)]).toEqual([scope, name, await toolShape(registry.tools[name]!)]);
    }
  }
});

type Part = LanguageModelV3StreamPart;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const call = (id: string, toolName: string, input: string): Part[] => [
  { type: "tool-input-start", id, toolName }, { type: "tool-input-delta", id, delta: input }, { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName, input }
];

async function collect(tools: ToolSet, parts: Part[]) {
  const model = createScriptedStreamLLM([[{ type: "stream-start", warnings: [] }, ...parts, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage }]]);
  const state = openAttemptStreamState({ model, timeout: {}, idleMs: 60_000, diagnostics: { startedAt: 0, callId: null, wakeId: "w", candidateIndex: 0, attempt: 1, idleTimeoutMs: 60_000 } });
  try {
    const out = await streamModelOnce({ model, tools, messages: [{ role: "user", content: "go" }], callOptions: { providerOptions: undefined, headers: undefined, reasoning: undefined }, askSummary: false }, state, { onReasoning() {}, onHeading() {}, onTextDelta() {} });
    return { ...out, collected: { ...out.collected, firstOutputMs: null } };
  } finally {
    state.idle.cleanup();
  }
}

test("a model's calls read the same through either tool set: transforms, trimming, bad input, unknown tools, cut-off JSON", async () => {
  for (const [scope, registry] of scopeRegistries()) {
    const names = Object.keys(registry.tools);
    const first = names[0]!;
    const parts: Part[] = [
      ...(names.includes("update_plan") ? call("c1", "update_plan", JSON.stringify({ steps: [{ id: "#3", status: "done" }] })) : []),
      ...(names.includes("ask_user") ? call("c2", "ask_user", JSON.stringify({ question: "  Ship it now?  " })) : []),
      ...(names.includes("read_file") ? call("c3", "read_file", JSON.stringify({ path: "notes.md", offset: 0 })) : []),
      ...call("c4", "no_such_tool", "{}"),
      ...call("c5", first, "{\"a\": ")
    ];
    const viaRegistry = await collect(registry.tools, parts);
    const viaCatalog = await collect(buildToolSet(registry.offeredSpecs()!, TOOL_INPUT_SCHEMAS), parts);
    expect([scope, viaCatalog]).toEqual([scope, viaRegistry]);
  }
});

/** Every parameter name in a JSON schema, as `<path>.<name>`. */
function parameterNames(node: unknown, at: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item, i) => parameterNames(item, `${at}[${i}]`, out));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "properties" && value && typeof value === "object") {
        for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
          out.push(`${at}.${name}`);
          parameterNames(inner, `${at}.${name}`, out);
        }
      } else {
        parameterNames(value, at, out);
      }
    }
  }
  return out;
}

test("no tool asks a model for a worker: workers are named as workers", () => {
  // The walk itself sees a nested name, so an empty list below means something.
  expect(parameterNames(z.toJSONSchema(z.object({ pane: z.object({ workerId: z.string() }) })), "probe")).toEqual(["probe.pane", "probe.pane.workerId"]);
  const named = Object.entries(TOOL_INPUT_SCHEMAS)
    .flatMap(([key, schema]) => parameterNames(z.toJSONSchema(schema, { unrepresentable: "any" }), key))
    .filter((name) => /feature/i.test(name.slice(name.lastIndexOf(".") + 1)));
  expect(named).toEqual([]);
});
