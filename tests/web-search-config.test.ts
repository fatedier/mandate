import { expect, test } from "bun:test";
import { loadConfig, type JsonObject } from "../src/server/config.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";
import { configFileProblems } from "../src/server/config/file-check.js";

const load = (file: JsonObject) => loadConfig(undefined, new MemoryJsonStore<JsonObject>(file)).webSearch;

const OFF = { use: "off", kinds: {} };

// What the config file says, and the webSearch value read from it.
const files: { name: string; file: JsonObject; webSearch: ReturnType<typeof load> }[] = [
  { name: "web search is off with nothing set up when the file says nothing", file: {}, webSearch: OFF },
  { name: "the choice and each kind's values are kept as the file has them, a kind this build lacks included",
    file: { webSearch: { use: "tavily", kinds: { tavily: { apiKey: "k" }, gone: { x: "y" } } } },
    webSearch: { use: "tavily", kinds: { tavily: { apiKey: "k" }, gone: { x: "y" } } } },
  { name: "a blank choice reads as off", file: { webSearch: { use: "  " } }, webSearch: OFF },
  { name: "a choice is read without the spaces around it", file: { webSearch: { use: " exa " } }, webSearch: { use: "exa", kinds: {} } }
];

test.each(files)("$name", ({ file, webSearch }) => {
  expect(load(file)).toEqual(webSearch);
});

test("values that are not text, kinds that are not objects, a choice that is not text are refused", () => {
  expect(configFileProblems({ webSearch: { use: 7, kinds: { tavily: { apiKey: 3, ok: "v" }, broken: "nope", list: [1] } } })).toEqual([
    "webSearch.use: must be text (it is a number)",
    "webSearch.kinds.tavily.apiKey: must be text (it is a number)",
    "webSearch.kinds.broken: must be an object (it is text)",
    "webSearch.kinds.list: must be an object (it is a list)"
  ]);
  expect(configFileProblems({ webSearch: "broken" })).toEqual(["webSearch: must be an object (it is text)"]);
});
