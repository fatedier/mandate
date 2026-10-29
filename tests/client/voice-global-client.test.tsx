import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { useVoiceStore } from "@/store/voice";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useAgentChatStore } from "@/store/agent-chat";
import { MobileVoiceStrip } from "@/routes/voice/MobileVoiceStrip";
import { VoiceDock } from "@/routes/voice/VoiceDock";
import { GlobalAgentPage } from "@/routes/global/GlobalAgentPage";
import { GlobalAgentRow } from "@/shell/GlobalAgentRow";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fakePhoneWidth } from "../fake-phone-width";
import { fakeVoiceMedia } from "../helpers/voice-media.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, mountAsync } from "../helpers/mount.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import type { GlobalAgentDto } from "@shared/api/global-agent";
import { fakeClock } from "../helpers/fake-clock.js";

afterEach(() => {
  runCleanups();
  useVoiceStore.getState().stopVoice();
  useVoiceStore.setState({ stopNotice: null });
  useGlobalAgentStore.setState({ agent: null, handoffs: new Map() });
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const agent = (over: Partial<GlobalAgentDto> = {}): GlobalAgentDto => ({ threadId: "thr_g", name: "Jarvis", named: true, unread: false, voiceConfigured: true, lastVisibleSeq: 0, questions: [], ...over });
/** The hook waits real seconds before each reconnect (1 s, then 2 s): tests
 *  of reconnects run on a fake clock and move it on. Everything else in a
 *  reconnect is promises, which `flush` lets run. */
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const tick = () => (jest.isFakeTimers() ? flush() : new Promise((r) => setTimeout(r, 0)));
const pass = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); await flush(); });
const has = (host: HTMLElement, selector: string) => host.querySelector(selector) !== null;
function Session() { useVoiceSession(); return null; }

test("the mic lives in the global composer only, and only when voice is set up", () => {
  act(() => useGlobalAgentStore.getState().setAgent(agent()));
  const global = mount(<ChatInput scope={{ type: "global", threadId: "thr_g" }} onSend={() => {}} />);
  expect(has(global.host, '[aria-label="Start voice"]')).toBe(true);
  act(() => global.host.querySelector<HTMLButtonElement>('[aria-label="Start voice"]')!.click());
  expect(useVoiceStore.getState().voiceMode).toBe(true);
  act(() => useVoiceStore.getState().stopVoice());
  const manager = mount(<ChatInput scope={{ type: "manager", threadId: "thr_a" }} onSend={() => {}} />);
  expect(has(manager.host, '[aria-label="Start voice"]')).toBe(false);
  act(() => useGlobalAgentStore.getState().setAgent(agent({ voiceConfigured: false })));
  global.rerender(<ChatInput scope={{ type: "global", threadId: "thr_g" }} onSend={() => {}} />);
  expect(has(global.host, '[aria-label="Start voice"]')).toBe(false);
});

test("the desktop dock shows on any page but the agent's while voice is on, says its state, and stops it", () => {
  act(() => useGlobalAgentStore.getState().setAgent(agent()));
  const { host, rerender } = mount(<MemoryRouter initialEntries={["/threads/thr_a"]}><VoiceDock collapsed={false} /></MemoryRouter>);
  expect(has(host, '[data-slot="voice-dock"]')).toBe(false);
  act(() => { useVoiceStore.getState().startVoice(); useVoiceStore.getState().setConnectionState("listening"); });
  rerender(<MemoryRouter initialEntries={["/threads/thr_a"]}><VoiceDock collapsed={false} /></MemoryRouter>);
  expect(host.querySelector('[data-slot="voice-dock"]')!.textContent).toContain("Listening");
  act(() => useVoiceStore.getState().setConnectionState("reconnecting"));
  expect(host.querySelector('[data-slot="voice-dock"]')!.textContent).toContain("Reconnecting…");
  // The agent's page has voice's bar where its composer was: one control.
  for (const collapsed of [false, true]) {
    const onAgent = mount(<MemoryRouter initialEntries={["/agent"]}><VoiceDock collapsed={collapsed} /></MemoryRouter>);
    expect([collapsed, has(onAgent.host, '[data-slot="voice-dock"]')]).toEqual([collapsed, false]);
    onAgent.unmount();
  }
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Stop voice"]')!.click());
  expect(useVoiceStore.getState().voiceMode).toBe(false);
  expect(has(host, '[data-slot="voice-dock"]')).toBe(false);
});

test("the phone strip shows on every page but the agent's, names the agent, goes to it, and stops voice where it is", () => {
  const restore = fakePhoneWidth();
  try {
    act(() => { useGlobalAgentStore.getState().setAgent(agent()); useVoiceStore.getState().startVoice(); useVoiceStore.getState().setConnectionState("listening"); });
    let at = "";
    function Where() { at = useLocation().pathname; return null; }
    const { host } = mount(<MemoryRouter initialEntries={["/home"]}><MobileVoiceStrip /><Where /></MemoryRouter>);
    const strip = host.querySelector('[data-slot="voice-strip"]')!;
    // Its words, spaced as read, with the dot's state read out.
    expect(strip.querySelector('[data-slot="voice-strip-back"]')!.textContent).toBe("Voice on Jarvis Listening");
    act(() => useVoiceStore.getState().setConnectionState("reconnecting"));
    expect(strip.textContent).toContain("Reconnecting…");
    act(() => strip.querySelector<HTMLButtonElement>('[data-slot="voice-strip-back"]')!.click());
    expect(at).toBe("/agent");
    // There voice's bar, where the composer was, is its one control.
    expect(has(host, '[data-slot="voice-strip"]')).toBe(false);
    // Elsewhere its Stop ends voice and stays on the page.
    const other = mount(<MemoryRouter initialEntries={["/memory"]}><MobileVoiceStrip /><Where /></MemoryRouter>);
    act(() => other.host.querySelector<HTMLButtonElement>('[data-slot="voice-strip"] [aria-label="Stop voice"]')!.click());
    expect(useVoiceStore.getState().voiceMode).toBe(false);
    expect(at).toBe("/memory");
    expect(has(other.host, '[data-slot="voice-strip"]')).toBe(false);
  } finally { restore(); }
});

test("a desktop has no voice strip", () => {
  act(() => useVoiceStore.getState().startVoice());
  const { host } = mount(<MemoryRouter initialEntries={["/home"]}><MobileVoiceStrip /></MemoryRouter>);
  expect(has(host, '[data-slot="voice-strip"]')).toBe(false);
});

test("the socket is the global one; reconnecting and resumed show; a limit stops voice with its notice and no reconnect", async () => {
  const media = fakeVoiceMedia();
  fakeClock();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    expect(media.sockets.map((s) => s.url.includes("threadId"))).toStrictEqual([false]);
    const socket = media.sockets[0]!;
    media.deliver(socket, { type: "ready" });
    expect(useVoiceStore.getState().connectionState).toBe("listening");
    media.deliver(socket, { type: "reconnecting" });
    expect(useVoiceStore.getState().connectionState).toBe("reconnecting");
    media.deliver(socket, { type: "resumed" });
    expect(useVoiceStore.getState().connectionState).toBe("listening");
    // The close follows the message at once, before React has torn anything down.
    act(() => {
      (socket.onmessage as (e: { data: string }) => void)({ data: JSON.stringify({ type: "closed", reason: "idle-timeout", afterMs: 300_000 }) });
      socket.onclose?.();
    });
    expect(useVoiceStore.getState()).toMatchObject({ voiceMode: false, connectionState: "idle", stopNotice: "Voice stopped after 5 minutes without talking." });
    await pass(1100);
    expect(media.sockets).toHaveLength(1);
  } finally { media.restore(); }
});

test("the length limit and a provider that did not come back each stop voice with their own notice", async () => {
  const media = fakeVoiceMedia();
  fakeClock();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    media.deliver(media.sockets[0]!, { type: "closed", reason: "max-session-reached", afterMs: 25 * 60_000 });
    expect(useVoiceStore.getState()).toMatchObject({ voiceMode: false, stopNotice: "Voice stopped after 25 minutes." });
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    expect(useVoiceStore.getState().stopNotice).toBe(null);
    media.deliver(media.sockets[1]!, { type: "closed", reason: "provider-unavailable" });
    expect(useVoiceStore.getState()).toMatchObject({ voiceMode: false, stopNotice: "Voice stopped: the voice service did not come back." });
    // One that would not open at all says the service's own words, and is not retried.
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    act(() => {
      (media.sockets[2]!.onmessage as (e: { data: string }) => void)({ data: JSON.stringify({ type: "closed", reason: "provider-unavailable", message: "auth: Incorrect API key provided" }) });
      media.sockets[2]!.onclose?.();
    });
    expect(useVoiceStore.getState()).toMatchObject({ voiceMode: false, stopNotice: "Voice stopped: auth: Incorrect API key provided" });
    await pass(1100);
    expect(media.sockets).toHaveLength(3);
  } finally { media.restore(); }
});

test("a socket that drops for no reason is reopened; another device taking over shows Moved, and Resume here takes it back", async () => {
  const media = fakeVoiceMedia();
  fakeClock();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    media.deliver(media.sockets[0]!, { type: "ready" });
    await act(async () => { media.sockets[0]!.onclose?.(); await tick(); });
    expect(useVoiceStore.getState().connectionState).toBe("reconnecting");
    // The dropped session's mic is let go before the next one is asked for.
    expect(media.stopped).toContain("mic0");
    await pass(1100);
    expect(media.sockets).toHaveLength(2);
    media.deliver(media.sockets[1]!, { type: "superseded" });
    await act(async () => { media.sockets[1]!.onclose?.(); await tick(); });
    expect(useVoiceStore.getState()).toMatchObject({ voiceMode: true, connectionState: "moved" });
    await pass(1100);
    expect(media.sockets).toHaveLength(2);
    await act(async () => { useVoiceStore.getState().resumeVoice(); await tick(); });
    expect(media.sockets).toHaveLength(3);
  } finally { media.restore(); }
});

test("stopping voice while a reconnect waits opens nothing more", async () => {
  const media = fakeVoiceMedia();
  fakeClock();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    await act(async () => { media.sockets[0]!.onclose?.(); await tick(); });
    act(() => useVoiceStore.getState().stopVoice());
    await pass(1100);
    expect(media.sockets).toHaveLength(1);
  } finally { media.restore(); }
});

test("a mic grant that arrives after voice was stopped and started again opens nothing extra", async () => {
  const media = fakeVoiceMedia("manual");
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    await act(async () => { useVoiceStore.getState().stopVoice(); useVoiceStore.getState().startVoice(); await tick(); });
    await act(async () => { media.grants[1]!(); await tick(); });
    await act(async () => { media.grants[0]!(); await tick(); });
    expect(media.sockets).toHaveLength(1);
    expect(media.stopped).toContain("mic0");
  } finally { media.restore(); }
});

test("a replaced session's socket closing late leaves the new one alone", async () => {
  const media = fakeVoiceMedia();
  fakeClock();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    await act(async () => { useVoiceStore.getState().resumeVoice(); await tick(); });
    media.deliver(media.sockets[1]!, { type: "ready" });
    await act(async () => { media.sockets[0]!.onclose?.(); await tick(); });
    expect(useVoiceStore.getState().connectionState).toBe("listening");
    await pass(1100);
    expect(media.sockets).toHaveLength(2);
  } finally { media.restore(); }
});

function serveAgentPage(seen: { agent: GlobalAgentDto }) {
  mockFetch((call) => {
    if (call.url.endsWith("/api/agents/global")) return jsonResponse({ agent: seen.agent });
    if (call.url.includes("/api/agents/global/handoffs")) return jsonResponse({ handoffs: [] });
    if (call.url.includes("/api/agents/global/seen")) return jsonResponse({ agent: seen.agent });
    if (call.url.includes("/api/agents/threads/thr_g")) {
      return jsonResponse({ thread: { id: "thr_g" }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null });
    }
    return jsonResponse({});
  });
}

test("on the agent's page: voice's bar while on, Moved with Resume here when another device took it, the stop notice after", async () => {
  const seen = { agent: agent() };
  serveAgentPage(seen);
  act(() => useGlobalAgentStore.getState().setAgent(seen.agent));
  const { host } = await mountAsync(<GlobalAgentPage />, { path: "/agent" });
  expect(has(host, '[aria-label="Start voice"]')).toBe(true);
  act(() => { useVoiceStore.getState().startVoice(); useVoiceStore.getState().setConnectionState("listening"); });
  expect(has(host, '[aria-label="Start voice"]')).toBe(false);
  expect(host.textContent).toContain("Listening");
  act(() => useVoiceStore.getState().setConnectionState("moved"));
  expect(host.querySelector('[data-slot="voice-moved"]')!.textContent).toContain("Voice moved to another device.");
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="voice-moved"] button')].find((b) => b.textContent === name)!;
  act(() => button("Resume here").click());
  expect(useVoiceStore.getState().connectionState).toBe("requesting-mic");
  // Moved, the page's own Stop leaves voice here (the strip and dock do not show on this page).
  act(() => useVoiceStore.getState().setConnectionState("moved"));
  act(() => button("Stop").click());
  expect(useVoiceStore.getState().voiceMode).toBe(false);
  expect(has(host, '[aria-label="Start voice"]')).toBe(true);
  act(() => { useVoiceStore.getState().startVoice(); useVoiceStore.getState().setConnectionState("listening"); });
  act(() => useVoiceStore.getState().stopVoice("Voice stopped after 5 minutes without talking."));
  expect(host.querySelector('[data-slot="voice-stopped"]')!.textContent).toBe("Voice stopped after 5 minutes without talking.");
  expect(has(host, '[aria-label="Start voice"]')).toBe(true);
  act(() => host.querySelector<HTMLButtonElement>('[data-slot="voice-stopped"] [aria-label="Dismiss"]')!.click());
  expect(has(host, '[data-slot="voice-stopped"]')).toBe(false);
  expect(useVoiceStore.getState().stopNotice).toBe(null);
});

test("the agent's row shows voice live, over the unread dot, and not while voice is on another device", () => {
  act(() => useGlobalAgentStore.getState().setAgent(agent({ unread: true })));
  const { host } = mount(<MemoryRouter><TooltipProvider><GlobalAgentRow current={false} /><GlobalAgentRow collapsed current={false} /></TooltipProvider></MemoryRouter>);
  const count = (selector: string) => host.querySelectorAll(selector).length;
  expect(count('[data-slot="global-agent-unread"]')).toBe(2);
  act(() => { useVoiceStore.getState().startVoice(); useVoiceStore.getState().setConnectionState("listening"); });
  // Expanded and collapsed alike.
  expect(count('[data-slot="global-agent-voice"]')).toBe(2);
  expect(count('[data-slot="global-agent-unread"]')).toBe(0);
  act(() => useVoiceStore.getState().setConnectionState("moved"));
  expect(has(host, '[data-slot="global-agent-voice"]')).toBe(false);
  act(() => useVoiceStore.getState().stopVoice());
  expect(has(host, '[data-slot="global-agent-unread"]')).toBe(true);
});

test("a spoken update reads as one in the transcript; an ordinary spoken answer does not", async () => {
  const { ChatMessageList } = await import("@/routes/window/chat/ChatMessageList");
  const { newThreadState } = await import("@/store/agent-chat");
  type Message = import("@/store/agent-chat").AgentMessage;
  const at = "2026-10-05T10:00:00.000Z";
  const said = (seq: number, text: string, spokenUpdate: boolean): Message => ({
    id: `m${seq}`, threadId: "thr_g", seq, role: "assistant", source: "voice", sourceThreadId: null, wakeId: null, createdAt: at,
    content: { type: "assistant", text, toolCalls: [], ...(spokenUpdate ? { spokenUpdate: true } : {}) }
  } as unknown as Message);
  const thread = { ...newThreadState(), threadId: "thr_g", loaded: true, messages: [said(1, "release answered: the install script stays.", true), said(2, "Anything else?", false)], oldestSeqLoaded: 1 };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  const updates = [...host.querySelectorAll('[data-slot="spoken-update"]')];
  expect(updates.map((el) => el.textContent)).toEqual(["Spoken updaterelease answered: the install script stays."]);
  expect(host.textContent).toContain("Anything else?");
});

const pcm = btoa(String.fromCharCode(...new Uint8Array(4800)));

test("the agent speaking shows as Speaking until its last sound ends", async () => {
  const media = fakeVoiceMedia();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    media.deliver(media.sockets[0]!, { type: "ready" });
    media.deliver(media.sockets[0]!, { type: "audio", pcm, sampleRate: 24000, channels: 1 });
    media.deliver(media.sockets[0]!, { type: "audio", pcm, sampleRate: 24000, channels: 1 });
    expect(useVoiceStore.getState().connectionState).toBe("speaking");
    act(() => media.sources[0]!.end());
    expect(useVoiceStore.getState().connectionState).toBe("speaking");
    act(() => media.sources[1]!.end());
    expect(useVoiceStore.getState().connectionState).toBe("listening");
  } finally { media.restore(); }
});

test("a mic that fails for a moment during a reconnect is asked again; one refused for good stops with why", async () => {
  const media = fakeVoiceMedia();
  fakeClock();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    media.micFailures.push(Object.assign(new Error("busy"), { name: "NotReadableError" }));
    await act(async () => { media.sockets[0]!.onclose?.(); await tick(); });
    await pass(1100);
    // The first retry could not get the mic: still reconnecting, and asked again.
    expect(useVoiceStore.getState()).toMatchObject({ voiceMode: true, connectionState: "reconnecting" });
    await pass(2100);
    expect(media.sockets).toHaveLength(2);
    media.deliver(media.sockets[1]!, { type: "ready" }); // back: the waits start over
    media.micFailures.push(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await act(async () => { media.sockets[1]!.onclose?.(); await tick(); });
    await pass(1100);
    expect(useVoiceStore.getState().connectionState).toBe("error");
    expect(useVoiceStore.getState().errorMessage).toContain("Microphone");
    await pass(2100);
    expect(media.sockets).toHaveLength(2);
  } finally { media.restore(); }
});

test("the dock stays while Settings has the sidebar", async () => {
  const { Sidebar } = await import("@/shell/Sidebar");
  act(() => { useGlobalAgentStore.getState().setAgent(agent()); useVoiceStore.getState().startVoice(); useVoiceStore.getState().setConnectionState("listening"); });
  const { host } = mount(<Sidebar />, { path: "/settings" });
  expect(has(host, '[aria-label="Settings sections"]')).toBe(true);
  expect(has(host, '[data-slot="voice-dock"]')).toBe(true);
});

test("resumed while its last words still play, the agent is Speaking until they end", async () => {
  const media = fakeVoiceMedia();
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    const socket = media.sockets[0]!;
    media.deliver(socket, { type: "ready" });
    media.deliver(socket, { type: "audio", pcm, sampleRate: 24000, channels: 1 });
    media.deliver(socket, { type: "reconnecting" });
    media.deliver(socket, { type: "resumed" });
    expect(useVoiceStore.getState().connectionState).toBe("speaking");
    act(() => media.sources[0]!.end());
    expect(useVoiceStore.getState().connectionState).toBe("listening");
  } finally { media.restore(); }
});

test("voice stopped by a limit says why on whatever page it stopped, until dismissed; the agent's page says it in its own place", () => {
  act(() => useGlobalAgentStore.getState().setAgent(agent()));
  act(() => { useVoiceStore.getState().startVoice(); useVoiceStore.getState().stopVoice("Voice stopped after 5 minutes without talking."); });
  const desk = mount(<MemoryRouter initialEntries={["/threads/thr_a"]}><VoiceDock collapsed={false} /></MemoryRouter>);
  expect(desk.host.querySelector('[data-slot="voice-stopped-notice"]')!.textContent).toContain("Voice stopped after 5 minutes without talking.");
  const onAgent = mount(<MemoryRouter initialEntries={["/agent"]}><VoiceDock collapsed={false} /></MemoryRouter>);
  expect(has(onAgent.host, '[data-slot="voice-stopped-notice"]')).toBe(false);
  const restore = fakePhoneWidth();
  try {
    const phone = mount(<MemoryRouter initialEntries={["/home"]}><MobileVoiceStrip /></MemoryRouter>);
    expect(phone.host.querySelector('[data-slot="voice-stopped-notice"]')!.textContent).toContain("Voice stopped after 5 minutes without talking.");
    act(() => phone.host.querySelector<HTMLButtonElement>('[data-slot="voice-stopped-notice"] [aria-label="Dismiss"]')!.click());
    expect(useVoiceStore.getState().stopNotice).toBe(null);
    expect(has(phone.host, '[data-slot="voice-stopped-notice"]')).toBe(false);
    expect(has(desk.host, '[data-slot="voice-stopped-notice"]')).toBe(false);
  } finally { restore(); }
});

test("one turn-on keeps one activation through the page's reconnects and Resume here; Stop and start again is a new one", async () => {
  const media = fakeVoiceMedia();
  fakeClock();
  const activation = (url: string) => new URL(url, "http://x").searchParams.get("activation");
  try {
    mount(<Session />);
    await act(async () => { useVoiceStore.getState().startVoice(); await tick(); });
    const first = activation(media.sockets[0]!.url);
    expect(first).toBeTruthy();
    await act(async () => { media.sockets[0]!.onclose?.(); await tick(); });
    await pass(1100);
    expect(activation(media.sockets[1]!.url)).toBe(first);
    await act(async () => { useVoiceStore.getState().resumeVoice(); await tick(); });
    expect(activation(media.sockets[2]!.url)).toBe(first);
    await act(async () => { useVoiceStore.getState().stopVoice(); useVoiceStore.getState().startVoice(); await tick(); });
    const next = activation(media.sockets[3]!.url);
    expect(next).toBeTruthy();
    expect(next).not.toBe(first);
  } finally { media.restore(); }
});

