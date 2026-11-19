import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { ScopeRuntime, WrappedDispatcher } from "../../runtime/scope.js";
import { SIDE_CHAT_BOUNDARY, SIDE_CHAT_REFUSED, SIDE_CHAT_TOOLS } from "./side-chat-texts.js";

export interface SideChatScopeDeps {
  /** The personal agent's scope, read when a side chat needs it: the scopes
   *  are built side by side, so it is not there yet when this one is. */
  personal: () => ScopeRuntime;
  agentStore: Pick<AgentStore, "getActiveMessages">;
  /** The personal agent's page folder; unset, `page/` in its own folder. */
  pageDir?: string;
}

/**
 * A side chat: the personal agent's conversation, forked to talk one topic
 * over. Its prompt is the personal agent's (system prompt, the tools in the
 * same order), so the main conversation's prompt cache serves it; what it
 * may not do is refused when it is called. It gets no digest of the agent's
 * state after the fork (its copy holds the one of that moment): it looks
 * things up with its tools.
 */
export function buildSideChatScope(deps: SideChatScopeDeps): ScopeRuntime {
  const refusedDirs = (threadId: string): string[] => {
    const scope = deps.personal().buildToolScope(threadId);
    const own = scope.kind === "manager" ? scope.managerDir : null;
    if (!own) return deps.pageDir ? [deps.pageDir] : [];
    // Its notes are the main conversation's (every turn of it reads their
    // index), and its page is published as that conversation's turns end.
    return [path.join(own, "notes"), deps.pageDir ?? path.join(own, "page")];
  };
  const wrappedDispatcher: WrappedDispatcher = {
    get registry() { return deps.personal().wrappedDispatcher.registry; },
    dispatch: async (call, ctx) => {
      if (!SIDE_CHAT_TOOLS.has(call.toolName) || refusedDirs(ctx.threadId).some((dir) => writesInto(call, dir))) {
        return { isError: true, error: SIDE_CHAT_REFUSED };
      }
      return deps.personal().wrappedDispatcher.dispatch(call, ctx);
    }
  };
  return {
    scope: "side_chat",
    verifyScopeId: () => "a side chat's thread is read by its id",
    buildSystemPrompt: (threadId) => deps.personal().buildSystemPrompt(threadId),
    // What the personal agent's context opens with after a compaction, and
    // what a side chat is: its first row says so, and once its own
    // compaction has dropped that row, its context does.
    async buildInitialContext(threadId) {
      const base = (await deps.personal().buildInitialContext?.(threadId))?.trim() ?? "";
      const told = deps.agentStore.getActiveMessages(threadId).some((m) => m.source === "side-chat-boundary");
      const parts = told ? [base] : [base, SIDE_CHAT_BOUNDARY];
      return parts.filter(Boolean).join("\n\n") || null;
    },
    buildToolScope: (threadId) => deps.personal().buildToolScope(threadId),
    wrappedDispatcher,
    get toolDefinitions() { return deps.personal().toolDefinitions; }
  };
}

/** Whether a write or edit lands in `dir`, links and letter case resolved as
 *  the file system resolves them: a path that does not exist yet goes by its
 *  nearest folder that does. */
export function writesInto(call: { toolName: string; args: unknown }, dir: string): boolean {
  if (call.toolName !== "write" && call.toolName !== "edit") return false;
  const target = (call.args as { path?: unknown } | null)?.path;
  // A relative path the tool refuses itself.
  if (typeof target !== "string" || !path.isAbsolute(target)) return false;
  const rel = path.relative(realOfNearest(path.resolve(dir)), realOfNearest(path.resolve(target)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realOfNearest(abs: string): string {
  const rest: string[] = [];
  for (let head = abs; ; head = path.dirname(head)) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest);
    } catch {
      if (path.dirname(head) === head) return abs;
      rest.unshift(path.basename(head));
    }
  }
}
