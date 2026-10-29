import type { ToolContext } from "../../src/server/modules/agent/tool-registry.js";
import type { AgentMessageContent } from "../../src/shared/agent-message-types.js";
import type { AgentMessageDto } from "../../src/shared/api/agents.js";

/**
 * Typed stand-ins for what tests used to build with `as any`: the shapes are
 * checked against the real types, so a fixture that drifts from them (a
 * renamed field, a misspelt method) fails the typecheck instead of passing
 * as whatever the cast said.
 */

/** Partial<T> admits an explicit undefined for any member
 *  (exactOptionalPropertyTypes is off), which would let a fixture blank out a
 *  required member and still type as complete. The helpers below keep a plain
 *  Partial parameter, so a fresh object literal keeps TypeScript's excess-
 *  property checks at every depth (a misspelt field inside a scope or a
 *  content is an error, as in a hand-written object), and refuse that
 *  undefined at run time instead. */
function refuseUndefined(helper: string, given: object, required: readonly PropertyKey[], hint: string): void {
  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(given, key) && (given as Record<PropertyKey, unknown>)[key] === undefined) {
      throw new Error(`${helper}: ${String(key)} is required; ${hint}`);
    }
  }
}

/** A dependency the test provides only in part. The members it gives are
 *  checked against T; the rest are absent, so code that reaches for one gets
 *  undefined, which is how the test learns it needed it. A member given as
 *  undefined is refused at run time, symbol keys included (T's required
 *  members are not known at run time, so any undefined is): leave it out
 *  instead. */
export function stub<T>(partial: Partial<T> = {}): T {
  for (const key of Reflect.ownKeys(partial)) {
    if ((partial as Record<PropertyKey, unknown>)[key] === undefined) {
      throw new Error(`stub: ${String(key)} is given as undefined; leave it out instead`);
    }
  }
  return partial as T;
}

/** What a tool's handler is called with: a complete manager context unless
 *  the test says otherwise. */
export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  refuseUndefined("toolContext", overrides, ["threadId", "wakeId", "scope"], "leave it out for the default");
  return {
    threadId: "thr_test",
    wakeId: "wake_test",
    scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] },
    ...overrides
  };
}

/** A result that must not be a tool's `{ error }` arm, narrowed to the other
 *  arm; throws with the error otherwise. Only narrows a result whose type is
 *  known — a tool reached through an untyped list returns unknown. */
export function ok<T>(result: T): Exclude<T, { error: string }> {
  if (result !== null && typeof result === "object" && "error" in result) {
    throw new Error(`expected a result, got an error: ${String((result as { error: unknown }).error)}`);
  }
  return result as Exclude<T, { error: string }>;
}

/** A message's content narrowed to `type`; throws naming the type it has. */
export function contentOf<K extends AgentMessageContent["type"]>(
  message: { content: AgentMessageContent },
  type: K
): Extract<AgentMessageContent, { type: K }> {
  if (message.content.type !== type) throw new Error(`expected ${type} content, got ${message.content.type}`);
  return message.content as Extract<AgentMessageContent, { type: K }>;
}

/** An agent message with plain defaults for what the test does not care
 *  about; its content is always the test's own. */
export function agentMessage(fields: Partial<AgentMessageDto> & Pick<AgentMessageDto, "content">): AgentMessageDto {
  refuseUndefined(
    "agentMessage",
    fields,
    ["id", "threadId", "seq", "role", "source", "sourceThreadId", "wakeId", "content", "createdAt"],
    "leave it out for the default"
  );
  return {
    id: "m1",
    threadId: "t1",
    seq: 1,
    role: "user",
    source: "user",
    sourceThreadId: null,
    wakeId: null,
    createdAt: "2026-05-15T00:00:00.000Z",
    ...fields
  };
}
