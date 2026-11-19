import { afterEach, expect, test } from "bun:test";
import { mount } from "../helpers/mount.js";
import { runCleanups } from "../helpers/cleanup.js";
import { PersonalAgentRow } from "@/shell/PersonalAgentRow";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { PersonalAgentDto } from "@shared/api/personal-agent";

afterEach(() => { runCleanups(); usePersonalAgentStore.setState({ agent: null, handoffs: new Map() }); });

const agent = (over: Partial<PersonalAgentDto>): PersonalAgentDto => ({ threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: true, lastVisibleSeq: 0, seenSeq: 0, questions: [], ...over });

test("unnamed: 'the personal agent' with a New tag; named: the name, no tag; unread: a dot", () => {
  usePersonalAgentStore.getState().setAgent(agent({}));
  const { host, rerender } = mount(<PersonalAgentRow current={false} />, { path: "/home" });
  const row = () => host.querySelector('[data-slot="personal-agent"]')!;
  expect(row().textContent).toContain("Personal agent");
  expect(Boolean(row().querySelector('[data-slot="personal-agent-new"]'))).toBe(true);
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true }));
  rerender(<PersonalAgentRow current={false} />);
  expect(row().textContent).toContain("Jarvis");
  expect(Boolean(row().querySelector('[data-slot="personal-agent-new"]'))).toBe(false);
  expect(Boolean(row().querySelector('[data-slot="personal-agent-unread"]'))).toBe(false);
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true }));
  rerender(<PersonalAgentRow current={false} />);
  expect(Boolean(row().querySelector('[data-slot="personal-agent-unread"]'))).toBe(true);
  expect(row().getAttribute("href")).toBe("/agent");
});

test("the row is the current page on /agent", () => {
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true }));
  const { host } = mount(<PersonalAgentRow current />, { path: "/agent" });
  expect(host.querySelector('[data-slot="personal-agent"]')!.getAttribute("aria-current")).toBe("page");
});

test("the event stream keeps the mounted row and the handoffs current", async () => {
  const { attachSnapshotSseListeners } = await import("@/lib/snapshot-sse-listeners");
  const { act } = await import("react");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const send = (event: string, data: unknown) => act(() => { source.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) })); });
  const { host } = mount(<PersonalAgentRow current={false} />, { path: "/home" });
  const row = () => host.querySelector('[data-slot="personal-agent"]')!;
  expect(row().textContent).toContain("Personal agent");
  // The connect burst: a named agent replaces "Personal agent" and its New tag.
  send("personalAgent", { agent: agent({ name: "Jarvis", named: true }) });
  expect(row().textContent).toContain("Jarvis");
  expect(Boolean(row().querySelector('[data-slot="personal-agent-new"]'))).toBe(false);
  send("personalAgentUpdated", { agent: agent({ name: "Friday", named: true }) });
  expect(row().textContent).toContain("Friday");
  expect(Boolean(row().querySelector('[data-slot="personal-agent-new"]'))).toBe(false);
  expect(Boolean(row().querySelector('[data-slot="personal-agent-unread"]'))).toBe(false);
  send("personalAgentUpdated", { agent: agent({ name: "Friday", named: true, unread: true }) });
  expect(Boolean(row().querySelector('[data-slot="personal-agent-unread"]'))).toBe(true);
  send("personalHandoffUpdated", { handoff: { id: "hof_1", state: "replied" } });
  expect(usePersonalAgentStore.getState().handoffs.get("hof_1")?.state).toBe("replied");
});

test("collapsed: the icon alone names the agent, and carries the unread dot", async () => {
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true }));
  const { host, rerender } = mount(<TooltipProvider><PersonalAgentRow collapsed current={false} /></TooltipProvider>, { path: "/home" });
  const row = () => host.querySelector('[data-slot="personal-agent"]')!;
  expect(row().getAttribute("aria-label")).toBe("Jarvis");
  expect(Boolean(row().querySelector('[data-slot="personal-agent-unread"]'))).toBe(false);
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true }));
  rerender(<TooltipProvider><PersonalAgentRow collapsed current={false} /></TooltipProvider>);
  expect(Boolean(row().querySelector('[data-slot="personal-agent-unread"]'))).toBe(true);
});

// A question the agent put to the user waits on them: the red dot, as on a
// thread whose manager asked. It outranks the dot for an unseen reply, and
// gives way only to voice being live, which is the user talking to it now.
test("a question the agent asked puts the needs-you dot on its row, over an unseen reply", () => {
  const question = { id: "q_1", question: "Tag 3.21 today?", options: [], askedAt: "2026-01-12T14:00:00.000Z" };
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, questions: [question] }));
  const { host, rerender } = mount(<PersonalAgentRow current={false} />, { path: "/home" });
  const row = () => host.querySelector('[data-slot="personal-agent"]')!;
  const dot = () => row().querySelector<HTMLElement>('[data-slot="personal-agent-question"]');
  expect(dot()?.getAttribute("role")).toBe("img");
  expect(dot()?.getAttribute("aria-label")).toBe("Needs your answer");
  expect(dot()!.className.split(/\s+/)).toContain("bg-status-input");
  expect(row().querySelector('[data-slot="personal-agent-unread"]') === null).toBe(true);
  // Answered: the unseen reply's dot is back.
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true }));
  rerender(<PersonalAgentRow current={false} />);
  expect(dot() === null).toBe(true);
  expect(row().querySelector('[data-slot="personal-agent-unread"]')).not.toBeNull();
  // Not yet named, it can still have asked.
  usePersonalAgentStore.getState().setAgent(agent({ questions: [question] }));
  rerender(<PersonalAgentRow current={false} />);
  expect(dot()).not.toBeNull();
  expect(row().querySelector('[data-slot="personal-agent-new"]') === null).toBe(true);
});

test("collapsed: the icon carries the needs-you dot too", async () => {
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, questions: [{ id: "q_1", question: "Tag 3.21 today?", options: [], askedAt: "2026-01-12T14:00:00.000Z" }] }));
  const { host } = mount(<TooltipProvider><PersonalAgentRow collapsed current={false} /></TooltipProvider>, { path: "/home" });
  const row = host.querySelector('[data-slot="personal-agent"]')!;
  expect(row.querySelector('[data-slot="personal-agent-question"]')?.getAttribute("aria-label")).toBe("Needs your answer");
  expect(row.querySelector('[data-slot="personal-agent-unread"]') === null).toBe(true);
});

test("held back again and again, its row shows the needs-you dot", () => {
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, heldBack: { times: 3, reason: "Deletes the shared build." } }));
  const { host } = mount(<PersonalAgentRow current={false} />, { path: "/home" });
  const row = host.querySelector('[data-slot="personal-agent"]')!;
  expect(row.querySelector('[data-slot="personal-agent-held"]')?.getAttribute("aria-label")).toBe("Needs you");
  expect(Boolean(row.querySelector('[data-slot="personal-agent-unread"]'))).toBe(false);
});
