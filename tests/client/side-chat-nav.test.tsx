import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useNavigate } from "react-router";
import { mount } from "../helpers/mount.js";
import { runCleanups } from "../helpers/cleanup.js";
import { PersonalAgentRow } from "@/shell/PersonalAgentRow";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useSideChatsStore } from "@/store/side-chats";
import { useUIStore } from "@/store/ui";
import type { PersonalAgentDto } from "@shared/api/personal-agent";
import type { SideChatDto } from "@shared/api/side-chat";

// The side chats are rows under the agent's in the sidebar and the phone's
// drawer: folded by default, the agent's row saying how many there are and
// whether one works or has something new.

afterEach(() => {
  runCleanups();
  usePersonalAgentStore.setState({ agent: null, handoffs: new Map() });
  useSideChatsStore.setState({ sideChats: null });
  useUIStore.setState({ personalSideChatsOpen: false });
  localStorage.removeItem("mandate.ui");
});

const agent = (over: Partial<PersonalAgentDto> = {}): PersonalAgentDto => ({ threadId: "thr_g", name: "Jarvis", named: true, unread: false, voiceConfigured: true, lastVisibleSeq: 0, seenSeq: 0, questions: [], ...over });
const chat = (id: string, over: Partial<SideChatDto> = {}): SideChatDto => ({
  id, title: `Chat ${id}`, named: true, createdAt: "2026-11-09T08:00:00.000Z", lastActivityAt: "2026-11-09T08:00:00.000Z", lastVisibleSeq: 3, seenSeq: 3, working: false, ...over
});

function setup(chats: SideChatDto[], path = "/home", onNavigate?: () => void) {
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll(chats);
  const view = mount(<PersonalAgentRow current={path === "/agent"} onNavigate={onNavigate} />, { path });
  const toggle = () => view.host.querySelector<HTMLButtonElement>('[data-slot="side-chats-toggle"]');
  const rows = () => [...view.host.querySelectorAll<HTMLAnchorElement>('[data-slot="side-chat-row"]')];
  const mark = () => toggle()?.querySelector('[role="img"]')?.getAttribute("aria-label") ?? null;
  return { ...view, toggle, rows, mark };
}

test("with no side chat the agent row is as today", () => {
  const s = setup([]);
  expect(s.toggle() === null).toBe(true);
  expect(s.host.querySelector('[data-slot="personal-agent"]')!.textContent).toBe("Jarvis");
});

test("folded by default: the agent row shows how many, working before new", () => {
  const s = setup([chat("thr_a"), chat("thr_b", { lastVisibleSeq: 5 })]);
  expect(s.rows().length).toBe(0);
  expect(s.toggle()!.getAttribute("aria-expanded")).toBe("false");
  expect(s.toggle()!.getAttribute("aria-label")).toBe("Show side chats");
  expect(s.toggle()!.textContent).toBe("2");
  // One has something new: the review dot.
  expect(s.mark()).toBe("New reply");
  // One works: the working mark, before the new one.
  act(() => { useSideChatsStore.getState().upsert(chat("thr_a", { working: true })); });
  expect(s.mark()).toBe("state: working");
  // Neither: no mark.
  act(() => {
    useSideChatsStore.getState().upsert(chat("thr_a"));
    useSideChatsStore.getState().upsert(chat("thr_b"));
  });
  expect(s.mark()).toBe(null);
});

test("the toggle unfolds and folds, and the choice is kept", () => {
  const s = setup([chat("thr_a")]);
  act(() => { s.toggle()!.click(); });
  expect([s.toggle()!.getAttribute("aria-expanded"), s.toggle()!.getAttribute("aria-label")]).toEqual(["true", "Hide side chats"]);
  expect(s.rows().length).toBe(1);
  expect(JSON.parse(localStorage.getItem("mandate.ui")!).state.personalSideChatsOpen).toBe(true);
  // Unfolded, the rows show their own marks: the agent row shows none for them.
  act(() => { useSideChatsStore.getState().upsert(chat("thr_a", { working: true })); });
  expect(s.mark()).toBe(null);
  act(() => { s.toggle()!.click(); });
  expect(s.toggle()!.getAttribute("aria-expanded")).toBe("false");
  expect(JSON.parse(localStorage.getItem("mandate.ui")!).state.personalSideChatsOpen).toBe(false);
});

test("a row per side chat: its title, working mark, new in bold, its page on click", () => {
  useUIStore.setState({ personalSideChatsOpen: true });
  const s = setup([chat("thr_a", { title: "Pricing", working: true }), chat("thr_b", { title: "Naming", lastVisibleSeq: 5 })]);
  const [first, second] = s.rows();
  expect([first!.getAttribute("href"), first!.textContent]).toEqual(["/agent/side-chats/thr_a", "Pricing"]);
  expect(first!.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("state: working");
  expect(first!.querySelector(".font-semibold") === null).toBe(true);
  // Something new: the bold title, and a screen reader hears it.
  expect(second!.textContent).toBe("NamingNew");
  expect(second!.querySelector(".font-semibold")?.textContent).toBe("Naming");
});

/** Goes where it is told, as a link elsewhere on the page would. */
let go: (path: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  go = (path) => { void navigate(path); };
  return null;
}

test("opening a side chat's page unfolds the group once; folding it there stays folded", () => {
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([chat("thr_a"), chat("thr_b")]);
  const view = mount(<><Navigator /><PersonalAgentRow current={false} /></>, { path: "/home" });
  const toggle = () => view.host.querySelector<HTMLButtonElement>('[data-slot="side-chats-toggle"]')!;
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  act(() => { go("/agent/side-chats/thr_a"); });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  // The user folds it there: it stays so on that page.
  act(() => { toggle().click(); });
  act(() => { go("/agent/side-chats/thr_a?again=1"); });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  // Another side chat opened: unfolded again.
  act(() => { go("/agent/side-chats/thr_b"); });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
});

test("the phone drawer shows the same rows and closes on a pick", () => {
  useUIStore.setState({ personalSideChatsOpen: true });
  let closed = 0;
  const s = setup([chat("thr_a")], "/home", () => { closed += 1; });
  act(() => { s.rows()[0]!.click(); });
  expect(closed).toBe(1);
});
