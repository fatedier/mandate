import { expect, test } from "bun:test";
import { createMemoryEmbedder } from "../src/server/modules/memory/embedding-provider.js";
import { loadConfig } from "../src/server/config.js";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers/temp.js";

test("createMemoryEmbedder: creates an OpenAI-compatible embedder from provider/model config", async () => {
  const dir = tempDir("md-memory-embedding-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: {
      providers: {
        localai: {
          type: "openai-compatible",
          baseURL: "https://embed.example/v1",
          apiKey: "embed-key"
        }
      }
    },
    memory: {
      embedding: {
        model: "localai/text-embedding-3-small"
      }
    }
  }), "utf8");

  let requestedUrl = "";
  let requestedAuth = "";
  const embedder = createMemoryEmbedder(loadConfig(dir), {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      requestedAuth = headers.get("authorization") ?? "";
      return Response.json({
        data: [{ embedding: [0.25, 0.75] }],
        usage: { prompt_tokens: 1, total_tokens: 1 }
      });
    }) as unknown as typeof fetch
  });

  expect(embedder?.model).toBe("localai/text-embedding-3-small");
  expect(await embedder?.embed("hello")).toEqual([0.25, 0.75]);
  expect(requestedUrl).toBe("https://embed.example/v1/embeddings");
  expect(requestedAuth).toBe("Bearer embed-key");
});

test("createMemoryEmbedder: returns null when embedding model uses an unsupported provider", () => {
  const dir = tempDir("md-memory-embedding-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: {
      providers: {
        claude: { type: "anthropic", apiKey: "anthropic-key" }
      }
    },
    memory: {
      embedding: {
        model: "claude/not-an-embedding-model"
      }
    }
  }), "utf8");

  expect(createMemoryEmbedder(loadConfig(dir))).toBe(null);
});

// An embedding that never answers ends at a deadline: memory extractions run
// one at a time, and one waiting on it forever would hold up every one after
// it.
test("createMemoryEmbedder: an embedding that never answers fails at its deadline", async () => {
  const dir = tempDir("md-memory-embedding-hang-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: { providers: { localai: { type: "openai-compatible", baseURL: "https://embed.example/v1", apiKey: "embed-key" } } },
    memory: { embedding: { model: "localai/text-embedding-3-small" } }
  }), "utf8");
  const embedder = createMemoryEmbedder(loadConfig(dir), {
    timeoutMs: 50,
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch
  })!;
  // Raced, so a regression fails here rather than hanging the run.
  const outcome = await Promise.race([
    embedder.embed("a memory").then(() => "answered", () => "failed"),
    Bun.sleep(2_000).then(() => "still waiting")
  ]);
  expect(outcome).toBe("failed");
});
