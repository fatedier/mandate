import { expect, test } from "bun:test";
import { loadConfig, type JsonObject } from "../src/server/config.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";

const load = (file: JsonObject) => loadConfig(undefined, new MemoryJsonStore<JsonObject>(file)).webSearch;

const OFF = { use: "off", kinds: {} };

// What the config file says, and the webSearch value read from it.
const files: { name: string; file: JsonObject; webSearch: ReturnType<typeof load> }[] = [
  { name: "web search is off with nothing set up when the file says nothing", file: {}, webSearch: OFF },
  { name: "the choice and each kind's values are kept as the file has them, a kind this build lacks included",
    file: { webSearch: { use: "tavily", kinds: { tavily: { apiKey: "k" }, gone: { x: "y" } } } },
    webSearch: { use: "tavily", kinds: { tavily: { apiKey: "k" }, gone: { x: "y" } } } },
  { name: "values that are not strings, and kinds that are not objects, are dropped",
    file: { webSearch: { use: "tavily", kinds: { tavily: { apiKey: 3, ok: "v" }, broken: "nope", list: [1] } } },
    webSearch: { use: "tavily", kinds: { tavily: { ok: "v" } } } },
  { name: "a choice that is not a string reads as off", file: { webSearch: { use: 7 } }, webSearch: OFF },
  { name: "a blank choice reads as off", file: { webSearch: { use: "  " } }, webSearch: OFF },
  { name: "a choice is read without the spaces around it", file: { webSearch: { use: " exa " } }, webSearch: { use: "exa", kinds: {} } },
  { name: "a webSearch that is not an object reads as off", file: { webSearch: "broken" }, webSearch: OFF }
];

test.each(files)("$name", ({ file, webSearch }) => {
  expect(load(file)).toEqual(webSearch);
});
