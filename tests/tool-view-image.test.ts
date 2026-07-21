import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFileToolPacks } from "../src/server/modules/agent/tool-packs.js";
import { buildViewImageTool, VIEW_IMAGE_MAX_IMAGE_BYTES } from "../src/server/modules/agent/tools/view-image.js";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { providerInstanceSupportsToolResultImages } from "../src/server/runtime/agent-scopes.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d
]);

function ctx(workingDir: string, input: { canonicalize?: boolean } = {}) {
  const realWorkingDir = input.canonicalize === false ? workingDir : fs.realpathSync(workingDir);
  return {
    threadId: "thread-1",
    wakeId: "wake-1",
    scope: {
      kind: "worker" as const,
      feature: { id: "feature-1", workingDir: realWorkingDir } as any,
      project: { workingDir: realWorkingDir } as any
    }
  } as any;
}

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-view-image-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("viewImageTool: returns typed image result for relative PNG path", async () => {
  await withTempDir(async (wd) => {
    fs.writeFileSync(path.join(wd, "screenshot.png"), PNG_BYTES);
    const result = await buildViewImageTool().handler({ path: "screenshot.png" }, ctx(wd));
    expect(result.type).toBe("view_image_result");
    expect(result.message).toBe("Viewed image: screenshot.png");
    expect(result.image.mediaType).toBe("image/png");
    expect(result.image.displayPath).toBe("screenshot.png");
    expect(result.image.name).toBe("screenshot.png");
    expect(result.image.data).toBe(PNG_BYTES.toString("base64"));
  });
});

test("viewImageTool: missing file returns clear path error", async () => {
  await withTempDir(async (wd) => {
    await expect(buildViewImageTool().handler({ path: "missing.png" }, ctx(wd)))
      .rejects.toThrow(/image file does not exist: missing\.png/i);
  });
});

test("viewImageTool: rejects non-image binary by magic number", async () => {
  await withTempDir(async (wd) => {
    fs.writeFileSync(path.join(wd, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await expect(buildViewImageTool().handler({ path: "blob.bin" }, ctx(wd)))
      .rejects.toThrow(/unsupported image type/i);
  });
});

test("viewImageTool: rejects oversized images before returning bytes", async () => {
  await withTempDir(async (wd) => {
    const bytes = Buffer.alloc(VIEW_IMAGE_MAX_IMAGE_BYTES + 1);
    PNG_BYTES.copy(bytes, 0);
    fs.writeFileSync(path.join(wd, "large.png"), bytes);
    await expect(buildViewImageTool().handler({ path: "large.png" }, ctx(wd)))
      .rejects.toThrow(/image exceeds 5MB limit/i);
  });
});

test("viewImageTool: rejects directory targets", async () => {
  await withTempDir(async (wd) => {
    fs.mkdirSync(path.join(wd, "folder"));
    await expect(buildViewImageTool().handler({ path: "folder" }, ctx(wd)))
      .rejects.toThrow(/path is a directory/i);
  });
});

test("viewImageTool: rejects symlink that resolves outside scope", async () => {
  await withTempDir(async (wd) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "md-view-image-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "outside.png"), PNG_BYTES);
      fs.symlinkSync(path.join(outside, "outside.png"), path.join(wd, "link.png"));
      await expect(buildViewImageTool().handler({ path: "link.png" }, ctx(wd)))
        .rejects.toThrow(/outside the current workspace scope/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("viewImageTool: allows images inside a symlinked workspace root", async () => {
  await withTempDir(async (parent) => {
    const realWorkspace = path.join(parent, "real-workspace");
    const linkWorkspace = path.join(parent, "linked-workspace");
    fs.mkdirSync(realWorkspace);
    fs.symlinkSync(realWorkspace, linkWorkspace, "dir");
    fs.writeFileSync(path.join(realWorkspace, "screenshot.png"), PNG_BYTES);

    const result = await buildViewImageTool().handler(
      { path: "screenshot.png" },
      ctx(linkWorkspace, { canonicalize: false })
    );

    expect(result.image.mediaType).toBe("image/png");
    expect(result.image.data).toBe(PNG_BYTES.toString("base64"));
  });
});

test("viewImageTool: rejects symlink escape from a symlinked workspace root", async () => {
  await withTempDir(async (parent) => {
    const realWorkspace = path.join(parent, "real-workspace");
    const linkWorkspace = path.join(parent, "linked-workspace");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(realWorkspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(realWorkspace, linkWorkspace, "dir");
    fs.writeFileSync(path.join(outside, "outside.png"), PNG_BYTES);
    fs.symlinkSync(path.join(outside, "outside.png"), path.join(realWorkspace, "escape.png"));

    await expect(buildViewImageTool().handler(
      { path: "escape.png" },
      ctx(linkWorkspace, { canonicalize: false })
    )).rejects.toThrow(/outside the current workspace scope/i);
  });
});

test("viewImageTool: runtime guard rejects unsupported model", async () => {
  await withTempDir(async (wd) => {
    fs.writeFileSync(path.join(wd, "screenshot.png"), PNG_BYTES);
    const tool = buildViewImageTool({ supportsImages: () => false });
    await expect(tool.handler({ path: "screenshot.png" }, ctx(wd)))
      .rejects.toThrow(/current agent model does not support image input/i);
  });
});

test("viewImageTool: runtime guard rejects unsupported tool-result image path", async () => {
  await withTempDir(async (wd) => {
    fs.writeFileSync(path.join(wd, "screenshot.png"), PNG_BYTES);
    const tool = buildViewImageTool({
      supportsImages: () => true,
      supportsToolResultImages: () => false
    });
    await expect(tool.handler({ path: "screenshot.png" }, ctx(wd)))
      .rejects.toThrow(/current agent model path does not support image file viewing/i);
  });
});

test("buildFileToolPacks: always registers view_image and leaves support to runtime guard", () => {
  const tools = buildFileToolPacks("feature", {
    supportsInputForScope: () => false,
    supportsInputForThread: () => false,
    supportsToolResultImagesForThread: () => false
  })[0]!.tools.map((tool) => tool.name);
  expect(tools).toContain("view_image");
});

test("buildFileToolPacks: allows view_image for responses-style image-capable paths", async () => {
  await withTempDir(async (wd) => {
    fs.writeFileSync(path.join(wd, "screenshot.png"), PNG_BYTES);
    const tool = buildFileToolPacks("feature", {
      supportsInputForThread: (_threadId, input) => input === "image",
      supportsToolResultImagesForThread: () => true
    })[0]!.tools.find((item) => item.name === "view_image")!;

    const result = await tool.handler({ path: "screenshot.png" }, ctx(wd));

    expect((result as any).type).toBe("view_image_result");
    expect((result as any).image.data).toBe(PNG_BYTES.toString("base64"));
  });
});

test("buildFileToolPacks: rejects view_image for chat-style image-capable paths", async () => {
  await withTempDir(async (wd) => {
    fs.writeFileSync(path.join(wd, "screenshot.png"), PNG_BYTES);
    const tool = buildFileToolPacks("feature", {
      supportsInputForThread: (_threadId, input) => input === "image",
      supportsToolResultImagesForThread: () => false
    })[0]!.tools.find((item) => item.name === "view_image")!;

    await expect(tool.handler({ path: "screenshot.png" }, ctx(wd)))
      .rejects.toThrow(/does not support image file viewing/i);
  });
});

test("viewImageTool: openai-compatible responses path is allowed but chat path is rejected", async () => {
  await withTempDir(async (wd) => {
    fs.writeFileSync(path.join(wd, "screenshot.png"), PNG_BYTES);
    const responsesModel = createAiSdkLanguageModel({
      provider: "openai-compatible",
      model: "gpt-5.5",
      apiKey: "sk-test",
      baseURL: "https://proxy.example/v1"
    })!;
    const chatModel = createAiSdkLanguageModel({
      provider: "openai-compatible",
      model: "gpt-5.5",
      apiKey: "sk-test",
      baseURL: "https://proxy.example/v1",
      openaiModelApi: "chat"
    })!;
    const meta = { provider: "openai-compatible" };
    const responsesTool = buildViewImageTool({
      supportsImages: () => true,
      supportsToolResultImages: () => providerInstanceSupportsToolResultImages({ meta, model: responsesModel })
    });
    const chatTool = buildViewImageTool({
      supportsImages: () => true,
      supportsToolResultImages: () => providerInstanceSupportsToolResultImages({ meta, model: chatModel })
    });

    await expect(responsesTool.handler({ path: "screenshot.png" }, ctx(wd)))
      .resolves.toMatchObject({ type: "view_image_result" });
    await expect(chatTool.handler({ path: "screenshot.png" }, ctx(wd)))
      .rejects.toThrow(/does not support image file viewing/i);
  });
});
