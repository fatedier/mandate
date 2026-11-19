import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useTaskBoardStore } from "@/store/task-board";
import type { Mention } from "@shared/mentions";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, typeInto } from "../helpers/mount.js";
import { managerThreadDto, taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// @ in a composer names tasks before threads; a task's comment box names the
// personal agent first.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), archived: [] });
    usePersonalAgentStore.setState({ agent: null });
  });
});

async function composer(mentions: { excludeId: string | null; agent?: boolean }) {
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map([["thr_p", managerThreadDto("thr_p", { title: "Parser errors", lastActivityAt: "2026-11-09T05:00:00.000Z" })]]), archived: [] });
    useTaskBoardStore.getState().replaceAll([
      taskDto("tsk_done", { title: "Parser cleanup", status: "done", updatedAt: "2026-11-09T09:00:00.000Z" }),
      taskDto("tsk_open", { title: "Parser rewrite", status: "progress", updatedAt: "2026-11-08T09:00:00.000Z" }),
      taskDto("tsk_gone", { title: "Parser gone", deletedAt: "2026-11-08T09:00:00.000Z" })
    ]);
    usePersonalAgentStore.setState({ agent: { threadId: "thr_g", name: "Juno", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } as never });
  });
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const sent: Mention[][] = [];
  const { host } = await mountAsync(<ChatInput onSend={(_c, _a, picked) => { sent.push(picked ?? []); }} mentions={mentions} />);
  const textarea = () => host.getElementsByTagName("textarea")[0]!;
  const groups = () => [...document.querySelectorAll<HTMLElement>('[data-slot="mention-list"] [role="group"]')].map((g) => [
    g.getAttribute("aria-label"),
    [...g.querySelectorAll('[role="option"] [data-slot="mention-title"]')].map((t) => t.textContent)
  ]);
  const key = async (name: string) => {
    await act(async () => {
      textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { textarea, groups, key, sent, type: (text: string) => typeInto(textarea(), text, text.length) };
}

test("@ lists tasks first, then threads", async () => {
  const c = await composer({ excludeId: null });
  await c.type("@Parser");
  // Open tasks before closed ones; a deleted one is not offered.
  expect(c.groups()).toEqual([["Tasks", ["Parser rewrite", "Parser cleanup"]], ["Threads", ["Parser errors"]]]);
  await c.key("Enter");
  expect(c.textarea().value).toBe("@Parser rewrite ");
  await c.key("Enter");
  expect(c.sent).toEqual([[{ kind: "task", id: "tsk_open", label: "Parser rewrite" }]]);
});

test("the comment box lists the agent first", async () => {
  const c = await composer({ excludeId: null, agent: true });
  await c.type("@");
  expect(c.groups()[0]).toEqual(["Personal agent", ["Juno"]]);
  expect(c.groups().map((g) => g[0])).toEqual(["Personal agent", "Tasks", "Threads"]);
  await c.type("@ju");
  expect(c.groups()).toEqual([["Personal agent", ["Juno"]]]);
  await c.key("Enter");
  expect(c.textarea().value).toBe("@Juno ");
});

test("a composer without the agent offers no agent", async () => {
  const c = await composer({ excludeId: null });
  await c.type("@Ju");
  expect(c.groups()).toEqual([]);
});
