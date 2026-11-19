import { create } from "zustand";
import type { AgentCommandDto, AgentRunCommandResponse } from "@shared/api-contracts";
import { errorText } from "@shared/error-text";
import { fetchScopeCommands, runScopeCommand } from "./agent-chat-api";
import type { ChatThreadScope } from "./agent-chat-types";
import { scopeKey } from "./agent-chat-utils";

interface CommandsState {
  /** The commands of each conversation asked for so far, by scope key. */
  byScope: Map<string, AgentCommandDto[]>;
  /** The line above each conversation's composer: what a typed command
   *  answered. Gone at the next keystroke or send. */
  noticeByScope: Map<string, string>;
  /** Asks the server for a conversation's commands, once. A failure leaves
   *  it without any: its composer then sends every draft as a message, as it
   *  did before commands existed; the next call asks again. */
  load: (scope: ChatThreadScope) => Promise<void>;
  /** Runs a draft as a command. A request that fails is a refusal: the draft
   *  stays, and the message says why. */
  run: (scope: ChatThreadScope, text: string, attachments?: number) => Promise<AgentRunCommandResponse>;
  /** Sets or (null) clears a conversation's line. */
  say: (scope: ChatThreadScope, text: string | null) => void;
}

/** Lists on their way, so two askers share one request. */
const loading = new Map<string, Promise<void>>();

export const useCommandsStore = create<CommandsState>((set, get) => ({
  byScope: new Map(),
  noticeByScope: new Map(),

  load: (scope) => {
    const key = scopeKey(scope);
    if (get().byScope.has(key)) return Promise.resolve();
    const pending = loading.get(key);
    if (pending) return pending;
    const request = fetchScopeCommands(scope)
      .then((commands) => set((state) => ({ byScope: new Map(state.byScope).set(key, commands) })))
      .catch(() => {})
      .finally(() => { loading.delete(key); });
    loading.set(key, request);
    return request;
  },

  run: async (scope, text, attachments = 0) => {
    try {
      return await runScopeCommand(scope, text, attachments);
    } catch (err) {
      return { taken: false, message: `Couldn't run ${text.trim().split(/\s+/, 1)[0]}: ${errorText(err)}` };
    }
  },

  say: (scope, text) => {
    const key = scopeKey(scope);
    if ((get().noticeByScope.get(key) ?? null) === text) return;
    set((state) => {
      const next = new Map(state.noticeByScope);
      if (text) next.set(key, text);
      else next.delete(key);
      return { noticeByScope: next };
    });
  }
}));
