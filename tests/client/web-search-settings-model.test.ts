import { expect, test } from "bun:test";
import type { SettingsConfigResponse, WebSearchSettingsConfig } from "@/routes/settings/types";
import { buildWebSearchPatch, webSearchFormFromConfig, webSearchStatus } from "@/routes/settings/web-search-settings-model";

const config = (webSearch: WebSearchSettingsConfig) => ({ webSearch }) as unknown as SettingsConfigResponse;
const SECTION: WebSearchSettingsConfig = {
  use: "exa",
  kinds: [
    { id: "exa", label: "Exa", description: "Exa's search API.", setUp: true, fields: [{ key: "apiKey", type: "secret", label: "API key", required: true, value: "", configured: true }] },
    { id: "searxng", label: "SearXNG", description: "d", setUp: false, fields: [{ key: "address", type: "url", label: "Address", required: true, value: "https://s.test" }] }
  ]
};

test("a form as saved sends only the choice", () => {
  const form = webSearchFormFromConfig(config(SECTION));
  expect(buildWebSearchPatch(form, config(SECTION))).toEqual({ webSearch: { use: "exa" } });
});

test("a typed key is sent, a blank draft is not, a removal is null", () => {
  const form = webSearchFormFromConfig(config(SECTION));
  form.secrets.exa!.apiKey = { draft: "  ", remove: false };
  expect(buildWebSearchPatch(form, config(SECTION))).toEqual({ webSearch: { use: "exa" } });
  form.secrets.exa!.apiKey = { draft: "ex-new", remove: false };
  expect(buildWebSearchPatch(form, config(SECTION))).toEqual({ webSearch: { use: "exa", kinds: { exa: { apiKey: "ex-new" } } } });
  form.secrets.exa!.apiKey = { draft: "", remove: true };
  expect(buildWebSearchPatch(form, config(SECTION))).toEqual({ webSearch: { use: "exa", kinds: { exa: { apiKey: null } } } });
});

test("a changed value is sent for its kind only; a cleared one as empty", () => {
  const form = webSearchFormFromConfig(config(SECTION));
  form.values.searxng!.address = "";
  form.use = "searxng";
  expect(buildWebSearchPatch(form, config(SECTION))).toEqual({ webSearch: { use: "searxng", kinds: { searxng: { address: "" } } } });
});

test("the status is read from what is saved", () => {
  expect(webSearchStatus(config({ ...SECTION, use: "off" }))).toEqual({ tone: "idle", label: "Off" });
  expect(webSearchStatus(config({ ...SECTION, use: "gone" }))).toEqual({ tone: "idle", label: "Off" });
  expect(webSearchStatus(config(SECTION))).toEqual({ tone: "ready", label: "Ready" });
  expect(webSearchStatus(config({ ...SECTION, use: "searxng" }))).toEqual({ tone: "attention", label: "Not set up" });
});
