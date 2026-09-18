import { expect, test } from "bun:test";
import { createMemoryEmbedder } from "../src/server/modules/memory/embedding-provider.js";
import { loadConfig } from "../src/server/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("createMemoryEmbedder: creates an OpenAI-compatible embedder from provider/model config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-memory-embedding-"));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createMemoryEmbedder: returns null when embedding model uses an unsupported provider", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-memory-embedding-"));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
