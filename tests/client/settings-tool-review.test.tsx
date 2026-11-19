import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@/lib/api-paths";
import { GeneralPane } from "@/routes/settings/GeneralPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@shared/settings";
import { jsonResponse, withFetch } from "../helpers/fetch.js";
import { mount, settleRounds, typeInto } from "../helpers/mount.js";

// Settings › General › Agents: the tool-call review's switch, off until the
// user turns it on, and their rules for it while it is on. It can be turned
// on only while its second look has a chat model to run on.

const PROVIDERS = { gw: { models: [{ id: "vendor/judge-1", kind: "decision" }, { id: "deepseek/deepseek-flash" }] } };

function config(agent: Record<string, unknown>): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    models: { providers: PROVIDERS },
    agent: {
      preferences: "", compressionThresholdTokens: 200000, logRequests: "off", personalAgentName: "",
      idleCompactionEnabled: true, idleCompactionLeadMinutes: 5, idleCompactionMinTokens: 200000,
      toolReviewEnabled: false, toolReviewRules: "",
      decisionsEnabled: true, decisionsModelFallbacks: [], modelOverrides: {},
      toolReviewSecondLookModel: { model: "", reasoningEffort: "" }, toolReviewSecondLookModelFallbacks: [],
      ...agent
    },
    retention: { chatMaxTableBytes: 1024 ** 3, chatToolResultHeadChars: 2000 }
  } as unknown as SettingsConfigResponse;
}

const WITH_CHAT = { decisionsModel: { model: "gw/vendor/judge-1", reasoningEffort: "" }, decisionsModelFallbacks: [{ model: "gw/deepseek/deepseek-flash", reasoningEffort: "" }] };
const JUDGE_ONLY = { decisionsModel: { model: "gw/vendor/judge-1", reasoningEffort: "" } };

async function withPane(agent: Record<string, unknown>, run: (host: HTMLElement, posts: Array<{ agent?: Record<string, unknown> }>) => Promise<void>) {
  const posts: Array<{ agent?: Record<string, unknown> }> = [];
  let saved = config(agent);
  await withFetch(
    (call) => {
      if (call.url === api.settingsConfig && (call.init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(call.init!.body)) as { agent?: Record<string, unknown> };
        posts.push(body);
        saved = config({ ...agent, ...body.agent });
        return jsonResponse(saved);
      }
      if (call.url === api.settingsConfig) return jsonResponse(saved);
      if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 1 });
      throw new Error(`unexpected fetch: ${call.url}`);
    },
    async () => {
      const { host } = mount(<SettingsConfigProvider><GeneralPane /></SettingsConfigProvider>);
      await settleRounds();
      await run(host, posts);
    }
  );
}

const reviewSwitch = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Review tool calls"]');
const rulesField = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your rules"]');

test("turning the review on shows the rules field and saves both with the section", async () => {
  await withPane(WITH_CHAT, async (host, posts) => {
    expect(host.textContent).toContain("Review tool calls");
    expect(host.textContent).toContain("Before an agent runs a command, types into a terminal or writes outside its work, another model checks it and holds back what needs your word. Off unless you turn it on.");
    const toggle = reviewSwitch(host)!;
    expect([toggle.disabled, toggle.getAttribute("aria-checked")]).toEqual([false, "false"]);
    expect(rulesField(host) === null).toBe(true);
    await act(async () => { toggle.click(); });
    const rules = rulesField(host)!;
    expect(host.textContent).toContain("Tool-call review");
    expect(rules.placeholder).toBe("Agents may push their own feature branches. Always ask me before anything touches production.");
    expect(host.textContent).toContain("In your own words: what agents may do without asking, and what always needs your word. Agents read this too, and the review counts it as yours.");
    await typeInto(rules, "Ask me before anything touches production.");
    const section = toggle.closest('[data-slot="settings-section"]')!;
    const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await act(async () => { save.click(); });
    await settleRounds();
    expect(posts.at(-1)?.agent).toMatchObject({ toolReviewEnabled: true, toolReviewRules: "Ask me before anything touches production." });
  });
});

test("with no second-look model the switch is off and says where to set one", async () => {
  await withPane(JUDGE_ONLY, async (host) => {
    const toggle = reviewSwitch(host)!;
    expect([toggle.disabled, toggle.getAttribute("aria-checked")]).toEqual([true, "false"]);
    expect(host.textContent).toContain("Set a model for the tool-call review's second look in Routing first.");
    expect(rulesField(host) === null).toBe(true);
  });
  // A model whose provider was removed runs nowhere: it does not count.
  await withPane({ ...JUDGE_ONLY, modelOverrides: { toolReviewSecondLook: true }, toolReviewSecondLookModel: { model: "gone/deepseek-flash", reasoningEffort: "" } }, async (host) => {
    expect(reviewSwitch(host)!.disabled).toBe(true);
  });
  await withPane({ decisionsModel: { model: "gone/deepseek-flash", reasoningEffort: "" } }, async (host) => {
    expect(reviewSwitch(host)!.disabled).toBe(true);
  });
  // Nor does one named like something every object has.
  await withPane({ decisionsModel: { model: "constructor/chat-1", reasoningEffort: "" } }, async (host) => {
    expect(reviewSwitch(host)!.disabled).toBe(true);
  });
  // Its own second-look route with a chat model is enough, Decisions or not.
  await withPane({ ...JUDGE_ONLY, decisionsEnabled: false, modelOverrides: { toolReviewSecondLook: true }, toolReviewSecondLookModel: { model: "gw/deepseek/deepseek-flash", reasoningEffort: "" } }, async (host) => {
    expect(reviewSwitch(host)!.disabled).toBe(false);
    expect(host.textContent).not.toContain("Set a model for the tool-call review's second look in Routing first.");
  });
});
