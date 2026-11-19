import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { toast } from "sonner";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { useConfirmStore } from "@/components/confirm-action";
import { RowFrame } from "@/routes/window/chat/TranscriptRowFrame";
import type { RowActions } from "@/routes/window/chat/row-actions";
import { useAgentChatStore } from "@/store/agent-chat";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settleUntil } from "../helpers/mount.js";
import { agentMessage } from "../helpers/typed.js";

// Delete on a message's own line, beside Copy: asked once, then the message
// goes from the conversation here and on the server.

afterEach(() => {
  runCleanups();
  act(() => {
    useConfirmStore.setState({ pending: null, resolver: null, returnFocus: null });
    useAgentChatStore.setState({ threadsByScope: new Map() });
  });
});

const line = (over: Partial<RowActions> = {}): RowActions => ({
  side: "end", copy: "waf", at: "2026-10-29T12:00:00.000Z", label: null, workedMs: null, latest: false, messageId: null,
  deleteId: "msg_stray", ...over
});

/** The conversation the store holds: an answered message, its reply, the stray one. */
function seed() {
  const messages = [
    agentMessage({ id: "msg_first", threadId: "thr_1", seq: 1, content: { type: "text", text: "Start the report" } }),
    agentMessage({ id: "msg_reply", threadId: "thr_1", seq: 2, role: "assistant", source: "self", content: { type: "assistant", text: "On it." } }),
    agentMessage({ id: "msg_stray", threadId: "thr_1", seq: 3, content: { type: "text", text: "waf" } })
  ];
  act(() => {
    useAgentChatStore.setState({
      threadsByScope: new Map([["manager:thr_1", { threadId: "thr_1", messages, loaded: true, pendingUserMessages: new Map() }]]) as never
    });
  });
}
const held = () => (useAgentChatStore.getState().threadsByScope.get("manager:thr_1")?.messages ?? []).map((m) => m.id);

async function render(actions: RowActions | null) {
  return mountAsync(<><RowFrame rowKey="msg_stray" at={null} actions={actions}><p>waf</p></RowFrame><ConfirmHost /></>);
}
const button = (host: ParentNode) => host.querySelector<HTMLButtonElement>('[data-slot="delete-message"]');
const dialogButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-confirm-dialog] button')].find((b) => b.textContent?.trim() === name);
const deleteCalls = (calls: FetchCall[]) => calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url, "http://x").pathname);

test("Delete sits on the message's line after Copy, named Delete message; a line with nothing to delete has none", async () => {
  const m = await render(line());
  const row = m.host.querySelector<HTMLElement>('[data-slot="row-actions"]')!;
  expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Copy message", "Delete message"]);
  expect(button(m.host)!.getAttribute("title")).toBe("Delete message");
  runCleanups();
  const plain = await render(line({ deleteId: null }));
  expect(button(plain.host) === null).toBe(true);
});

test("asked first; confirmed, the message is deleted on the server and leaves the conversation", async () => {
  seed();
  const calls = mockFetch((call) => (call.method === "DELETE" ? jsonResponse({ ok: true, removed: ["msg_stray"] }) : jsonResponse({}, 404)));
  const m = await render(line());
  await act(async () => { button(m.host)!.click(); });
  await settleUntil(() => document.querySelector("[data-confirm-dialog]") !== null, "the question");
  const dialog = document.querySelector<HTMLElement>("[data-confirm-dialog]")!;
  expect(dialog.textContent).toContain("Delete this message?");
  expect(dialog.textContent).toContain("It is removed from the conversation for good. The agent will not see it.");
  // Nothing is sent until it is confirmed.
  expect(deleteCalls(calls)).toEqual([]);
  await act(async () => { dialogButton("Delete")!.click(); });
  await settleUntil(() => deleteCalls(calls).length === 1, "the delete request");
  expect(deleteCalls(calls)).toEqual(["/api/agents/threads/thr_1/messages/msg_stray"]);
  await settleUntil(() => !held().includes("msg_stray"), "the message gone from the conversation");
  expect(held()).toEqual(["msg_first", "msg_reply"]);
});

test("cancelled, nothing is sent and the message stays", async () => {
  seed();
  const calls = mockFetch(() => jsonResponse({}, 404));
  const m = await render(line());
  await act(async () => { button(m.host)!.click(); });
  await settleUntil(() => dialogButton("Cancel") !== undefined, "the question");
  await act(async () => { dialogButton("Cancel")!.click(); });
  expect([deleteCalls(calls), held()]).toEqual([[], ["msg_first", "msg_reply", "msg_stray"]]);
});

test("refused by the server, its words are shown and the message stays", async () => {
  seed();
  const said: string[] = [];
  const original = toast.error;
  onCleanup(() => { toast.error = original; });
  toast.error = ((message: string) => { said.push(String(message)); return ""; }) as typeof toast.error;
  mockFetch((call) => (call.method === "DELETE" ? jsonResponse({ error: "The agent has answered this message, so it can't be deleted." }, 409) : jsonResponse({}, 404)));
  const m = await render(line());
  await act(async () => { button(m.host)!.click(); });
  await settleUntil(() => dialogButton("Delete") !== undefined, "the question");
  await act(async () => { dialogButton("Delete")!.click(); });
  await settleUntil(() => said.length === 1, "the refusal shown");
  expect(said).toEqual(["The agent has answered this message, so it can't be deleted."]);
  expect(held()).toEqual(["msg_first", "msg_reply", "msg_stray"]);
});

test("told by the stream, the messages leave the conversation in any open page", () => {
  seed();
  act(() => { useAgentChatStore.getState().onMessagesDeleted("thr_1", ["msg_stray", "msg_unknown"]); });
  expect(held()).toEqual(["msg_first", "msg_reply"]);
  // A thread this page does not hold: nothing to do.
  act(() => { useAgentChatStore.getState().onMessagesDeleted("thr_other", ["msg_first"]); });
  expect(held()).toEqual(["msg_first", "msg_reply"]);
});
