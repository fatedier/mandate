import { expect, test } from "bun:test";
import fs from "node:fs";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import {
  MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS,
  prepareAiSdkMessages
} from "../src/server/modules/agent/wake-message-adapter.js";
import { featureMessageNoteMetadata, featureMessageReplyMetadata } from "../src/shared/feature-message.js";
import { subagentTaskMetadata } from "../src/shared/subagent-task.js";
import { subagentResultMetadata } from "../src/shared/subagent-messages.js";
import { mentionsMetadata } from "../src/shared/mentions.js";
import type { ModelMessage, ToolResultPart } from "ai";

function agentMessage(overrides: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage {
  return {
    id: overrides.id ?? "msg-1",
    threadId: overrides.threadId ?? "thread-1",
    seq: overrides.seq ?? 1,
    role: overrides.role,
    source: overrides.source ?? "user",
    sourceThreadId: overrides.sourceThreadId ?? null,
    wakeId: overrides.wakeId ?? null,
    content: overrides.content,
    createdAt: overrides.createdAt ?? "2026-05-15T00:00:00.000Z"
  };
}

type ToolOutput = ToolResultPart["output"];

function isOutput<K extends ToolOutput["type"]>(output: ToolOutput, type: K): output is Extract<ToolOutput, { type: K }> {
  return output.type === type;
}

/** The output of a prepared tool message's first result, of the type the
 *  test expects; throws naming what it found otherwise. */
function toolOutputOf<K extends ToolOutput["type"]>(message: ModelMessage | undefined, type: K): Extract<ToolOutput, { type: K }> {
  const part = message?.role === "tool" ? message.content[0] : undefined;
  if (part?.type !== "tool-result") throw new Error(`expected a tool result, got a ${message?.role} message`);
  if (!isOutput(part.output, type)) throw new Error(`expected ${type} output, got ${part.output.type}`);
  return part.output;
}

test("prepareAiSdkMessages: identifies feature-agent conversation replies", () => {
  const messages = prepareAiSdkMessages([agentMessage({
    role: "user",
    source: "feature-message",
    content: {
      type: "text",
      text: "The parser stays incremental.",
      metadata: featureMessageReplyMetadata({
        featureId: "feat-1",
        featureName: "Parser"
      })
    }
  })], { includeImages: true });

  expect(messages).toEqual([{
    role: "user",
    content: "[Worker message from Parser]\nThe parser stays incremental."
  }]);
});

// A note of what the user told a worker is the manager's to read as written:
// it is no worker's message.
test("prepareAiSdkMessages: a note of what the user told a worker reads as written, not as the worker's message", () => {
  const text = "The user wrote to your worker \"Parser\" directly; the worker has the message:\n\nKeep it incremental.\n\nNo reply is needed. Take it into account when you next direct this worker.";
  const messages = prepareAiSdkMessages([agentMessage({
    role: "user",
    source: "feature-message",
    content: {
      type: "text",
      text,
      metadata: featureMessageNoteMetadata({ featureId: "feat-1", featureName: "Parser", by: "user", text: "Keep it incremental.", attachments: 0 })
    }
  })], { includeImages: true });
  expect(messages).toEqual([{ role: "user", content: text }]);
});

test("prepareAiSdkMessages: a subagent's task reads as handed over by whoever asked; one that does not say reads as written", () => {
  const task = (metadata?: Record<string, unknown>) => agentMessage({
    role: "user",
    source: "subagent-task",
    content: { type: "text", text: "Write the 0.72 release notes.", ...(metadata ? { metadata } : {}) }
  });
  expect(prepareAiSdkMessages([task(subagentTaskMetadata({ taskId: "task_1", askedBy: "Release 0.72" }))], { includeImages: true }))
    .toEqual([{ role: "user", content: "[Task from Release 0.72]\nWrite the 0.72 release notes." }]);
  // It is told where its shell starts, when the task says.
  expect(prepareAiSdkMessages([task(subagentTaskMetadata({ taskId: "task_1", askedBy: "Release 0.72", workingDir: "/repo/project-1" }))], { includeImages: true }))
    .toEqual([{ role: "user", content: "[Task from Release 0.72]\nWorking directory: /repo/project-1.\nWrite the 0.72 release notes." }]);
  expect(prepareAiSdkMessages([task(subagentTaskMetadata({ taskId: "task_1", askedBy: "Your agent" }))], { includeImages: true }))
    .toEqual([{ role: "user", content: "[Task from Your agent]\nWrite the 0.72 release notes." }]);
  expect(prepareAiSdkMessages([task()], { includeImages: true }))
    .toEqual([{ role: "user", content: "Write the 0.72 release notes." }]);
});

// A subagent's result comes back already worded for the model, as a worker's
// report does: its text reads as written, with no header of its own, and the
// card's copy in its metadata is not read.
test("prepareAiSdkMessages: a subagent's result reads as written", () => {
  const result = "[Subagent result] “Find the retry call sites”: finished after 4m 12s.\n\nTwo call sites.";
  const messages = prepareAiSdkMessages([
    agentMessage({
      id: "msg-1", seq: 1, role: "user", source: "subagent-result",
      content: {
        type: "text", text: result,
        metadata: subagentResultMetadata({ taskId: "task_1", outcome: "finished", title: "Find the retry call sites", durationMs: 252_000, reply: "Two call sites.", error: null })
      }
    })
  ], { includeImages: true });
  expect(messages).toEqual([{ role: "user", content: result }]);
});

test("prepareAiSdkMessages: preserves string tool results as text output", () => {
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } }]
      }
    }),
    agentMessage({
      id: "tool-1",
      seq: 2,
      role: "tool",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "bash",
        result: "/path/to/project"
      }
    })
  ];

  expect(prepareAiSdkMessages(messages, { includeImages: true })).toEqual([
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "pwd" }
      }]
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "bash",
        output: { type: "text", value: "/path/to/project" }
      }]
    }
  ]);
});

test("prepareAiSdkMessages: keeps object tool results as json output", () => {
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "get_feature_status", args: {} }]
      }
    }),
    agentMessage({
      id: "tool-1",
      seq: 2,
      role: "tool",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "get_feature_status",
        result: { ok: true, panes: ["%1"] }
      }
    })
  ];

  expect(prepareAiSdkMessages(messages, { includeImages: true })[1]).toEqual({
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "get_feature_status",
      output: { type: "json", value: { ok: true, panes: ["%1"] } }
    }]
  });
});

test("prepareAiSdkMessages: replays stored SDK assistant messages by default", () => {
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        sdkAssistantMessages: [{
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "",
              providerOptions: {
                openai: {
                  itemId: "rs_1",
                  reasoningEncryptedContent: "encrypted-reasoning"
                }
              }
            },
            { type: "text", text: "Visible answer" }
          ]
        }],
        text: "Visible answer"
      }
    })
  ];

  expect(prepareAiSdkMessages(messages, { includeImages: true })).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "encrypted-reasoning"
            }
          }
        },
        { type: "text", text: "Visible answer" }
      ]
    }
  ]);
});

test("prepareAiSdkMessages: can ignore provider state and use visible assistant content", () => {
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        sdkAssistantMessages: [{
          role: "assistant",
          content: [{
            type: "reasoning",
            text: "",
            providerOptions: {
              openai: {
                itemId: "rs_1",
                reasoningEncryptedContent: "encrypted-reasoning"
              }
            }
          }]
        }],
        text: "Visible answer"
      }
    })
  ];

  expect(prepareAiSdkMessages(messages, {
    includeImages: true,
    includeProviderState: false
  })).toEqual([
    {
      role: "assistant",
      content: [{ type: "text", text: "Visible answer" }]
    }
  ]);
});

test("prepareAiSdkMessages: maps view_image result to file content output", () => {
  const imageBase64 = Buffer.from("png-bytes").toString("base64");
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } }]
      }
    }),
    agentMessage({
      id: "tool-1",
      seq: 2,
      role: "tool",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "view_image",
        result: {
          type: "view_image_result",
          message: "Viewed image: screenshot.png",
          image: {
            type: "image",
            id: "img-1",
            name: "screenshot.png",
            displayPath: "screenshot.png",
            mediaType: "image/png",
            data: imageBase64,
            sizeBytes: 9
          }
        }
      }
    })
  ];

  const output = toolOutputOf(prepareAiSdkMessages(messages, { includeImages: true })[1], "content");
  expect(output).toEqual({
    type: "content",
    value: [
      { type: "text", text: "Viewed image: screenshot.png" },
      {
        type: "file",
        data: { type: "data", data: imageBase64 },
        mediaType: "image/png",
        filename: "screenshot.png"
      }
    ]
  });
  type ContentPart = (typeof output.value)[number];
  expect(output.value.find((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")?.text).not.toContain(imageBase64);
});

// An image fitted for the model goes in its place, a tool's or an attached
// one; one with nothing fitted goes as it is.
test("prepareAiSdkMessages: an image fitted for the model is sent in its place", () => {
  const attached = { type: "image" as const, id: "att-1", name: "shot.png", mediaType: "image/png", data: "T1JJR0lOQUw=", sizeBytes: 8 };
  const viewed = { type: "image" as const, id: "img-1", name: "page.png", displayPath: "page.png", mediaType: "image/png", data: "T1JJR0lOQUw=", sizeBytes: 8 };
  const messages = [
    agentMessage({ id: "u1", role: "user", content: { type: "text", text: "look", attachments: [attached] } }),
    agentMessage({ id: "a1", seq: 2, role: "assistant", source: "self", content: { type: "assistant", toolCalls: [{ toolCallId: "call-1", toolName: "view_image", args: { path: "page.png" } }] } }),
    agentMessage({ id: "t1", seq: 3, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "call-1", toolName: "view_image", result: { type: "view_image_result", message: "Viewed image: page.png", image: viewed } } })
  ];
  const fitted = prepareAiSdkMessages(messages, {
    includeImages: true,
    imageForModel: (image, messageId) => ((image.id === "img-1" && messageId === "t1") || (image.id === "att-1" && messageId === "u1") ? { data: `FIT-${image.id}`, mediaType: "image/jpeg" } : null)
  });
  const userFile = (fitted[0]!.content as Array<{ type: string; data?: unknown; mediaType?: string }>).find((part) => part.type === "file");
  expect(userFile).toMatchObject({ data: { type: "data", data: "FIT-att-1" }, mediaType: "image/jpeg" });
  expect(toolOutputOf(fitted[2], "content").value[1]).toMatchObject({ type: "file", data: { type: "data", data: "FIT-img-1" }, mediaType: "image/jpeg" });
  const asIs = prepareAiSdkMessages(messages, { includeImages: true, imageForModel: () => null });
  expect(toolOutputOf(asIs[2], "content").value[1]).toMatchObject({ data: { type: "data", data: "T1JJR0lOQUw=" }, mediaType: "image/png" });
});

const viewImageBytesOmitted: { name: string; options: Parameters<typeof prepareAiSdkMessages>[1] }[] = [
  { name: "omits historical view_image bytes when images are disabled", options: { includeImages: false } },
  { name: "omits view_image bytes when tool-result images are disabled", options: { includeImages: true, includeToolResultImages: false } }
];

test.each(viewImageBytesOmitted)("prepareAiSdkMessages: $name", ({ options }) => {
  const imageBase64 = Buffer.from("png-bytes").toString("base64");
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } }]
      }
    }),
    agentMessage({
      id: "tool-1",
      seq: 2,
      role: "tool",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "view_image",
        result: {
          type: "view_image_result",
          message: "Viewed image: screenshot.png",
          image: {
            type: "image",
            id: "img-1",
            name: "screenshot.png",
            displayPath: "screenshot.png",
            mediaType: "image/png",
            data: imageBase64,
            sizeBytes: 9
          }
        }
      }
    })
  ];

  const output = toolOutputOf(prepareAiSdkMessages(messages, options)[1], "text");
  expect(output.value).toContain("does not support image tool-result input");
  expect(JSON.stringify(output)).not.toContain(imageBase64);
});

test("prepareAiSdkMessages: truncates oversized string tool results for the model", () => {
  const longOutput = "x".repeat(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS + 100);
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "bash", args: { command: "cat huge.log" } }]
      }
    }),
    agentMessage({
      id: "tool-1",
      seq: 2,
      role: "tool",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "bash",
        result: longOutput
      }
    })
  ];

  const output = toolOutputOf(prepareAiSdkMessages(messages, { includeImages: true })[1], "text");
  expect(output.value).toContain("[truncated 100 chars]");
  expect(output.value.length).toBeLessThan(longOutput.length);
});

// Older rows only: a result is cut at the call (tool-output-spool), under
// this; one stored before that cut existed is cut here, the same each time.
test("prepareAiSdkMessages: a stored result of 25,000 characters reaches the model whole; the backstop is at 30,000", () => {
  expect(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS).toBe(30_000);
  const stored = "y".repeat(25_000);
  const messages = [
    agentMessage({ id: "assistant-1", role: "assistant", content: { type: "assistant", toolCalls: [{ toolCallId: "call-1", toolName: "bash", args: { command: "cat build.log" } }] } }),
    agentMessage({ id: "tool-1", seq: 2, role: "tool", content: { type: "tool_result", toolCallId: "call-1", toolName: "bash", result: stored } })
  ];
  expect(toolOutputOf(prepareAiSdkMessages(messages, { includeImages: true })[1], "text").value).toBe(stored);
});

test("prepareAiSdkMessages: truncates oversized object tool results as text", () => {
  const messages = [
    agentMessage({
      id: "assistant-1",
      role: "assistant",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "readFile", args: { path: "large.ts" } }]
      }
    }),
    agentMessage({
      id: "tool-1",
      seq: 2,
      role: "tool",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "readFile",
        result: { contents: "x".repeat(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS + 100) }
      }
    })
  ];

  const output = toolOutputOf(prepareAiSdkMessages(messages, { includeImages: true })[1], "text");
  expect(output.value).toContain("\"contents\"");
  expect(output.value).toContain("[truncated");
});

test("prepareAiSdkMessages: keeps runtime contexts append-only", () => {
  const messages = [
    agentMessage({
      id: "user-1",
      role: "user",
      content: { type: "text", text: "hello" }
    }),
    agentMessage({
      id: "initial-1",
      seq: 2,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[initial_context]\nbase-v1",
        metadata: { runtimeContextKind: "initial" }
      }
    }),
    agentMessage({
      id: "runtime-1",
      seq: 3,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\nstate-v1",
        metadata: { runtimeContextKind: "update" }
      }
    }),
    agentMessage({
      id: "user-2",
      seq: 4,
      role: "user",
      content: { type: "text", text: "next" }
    }),
    agentMessage({
      id: "runtime-2",
      seq: 5,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\nstate-v2",
        metadata: { runtimeContextKind: "update" }
      }
    })
  ];

  const textMessages = prepareAiSdkMessages(messages, { includeImages: true })
    .filter((message): message is { role: "user"; content: string } =>
      message.role === "user" && typeof message.content === "string"
    )
    .map((message) => message.content);

  expect(textMessages).toEqual([
    "hello",
    "[initial_context]\nbase-v1",
    "[runtime_context]\nstate-v1",
    "next",
    "[runtime_context]\nstate-v2"
  ]);
});

test("prepareAiSdkMessages: latest initial context resets older runtime updates", () => {
  const messages = [
    agentMessage({
      id: "initial-1",
      role: "user",
      source: "runtime-context",
      content: { type: "text", text: "[initial_context]\nbase-v1", metadata: { runtimeContextKind: "initial" } }
    }),
    agentMessage({
      id: "runtime-1",
      seq: 2,
      role: "user",
      source: "runtime-context",
      content: { type: "text", text: "[runtime_context]\nstate-v1" }
    }),
    agentMessage({
      id: "initial-2",
      seq: 3,
      role: "user",
      source: "runtime-context",
      content: { type: "text", text: "[initial_context]\nbase-v2", metadata: { runtimeContextKind: "initial" } }
    })
  ];

  expect(prepareAiSdkMessages(messages, { includeImages: true })).toEqual([
    { role: "user", content: "[initial_context]\nbase-v2" }
  ]);
});

// A manager or a worker is told when a message was written by the user's
// agent for them: the page says "via <name>", the
// model reads one leading line.
test("prepareAiSdkMessages: a message the user's agent sent says so in one leading line, by the name it had", () => {
  const sent = agentMessage({ role: "user", content: { type: "text", text: "Fix the timeout", relay: { by: "global", spoken: false, handoffId: "h", name: "Atlas" } } });
  expect(prepareAiSdkMessages([sent], { includeImages: false })).toEqual([{ role: "user", content: "[via Atlas, the user's agent]\nFix the timeout" }]);
});

test("prepareAiSdkMessages: one sent before names were kept says it without a name; the user's own message says nothing", () => {
  const old = agentMessage({ role: "user", content: { type: "text", text: "Fix the timeout", relay: { by: "global", spoken: false, handoffId: "h" } } });
  expect(prepareAiSdkMessages([old], { includeImages: false })).toEqual([{ role: "user", content: "[via the user's agent]\nFix the timeout" }]);
  const own = agentMessage({ role: "user", content: { type: "text", text: "Fix the timeout" } });
  expect(prepareAiSdkMessages([own], { includeImages: false })).toEqual([{ role: "user", content: "Fix the timeout" }]);
});

// The line means nothing to a model that was not told how to read it.
test("the manager's and the worker's prompts say how to read that line, and whose words are the user's", () => {
  for (const file of ["manager.md", "worker.md"]) {
    const prompt = fs.readFileSync(`src/server/modules/agent/prompts/${file}`, "utf8").replace(/\s+/g, " ");
    expect([file, prompt.includes("A message that begins `[via <name>, the user's agent]` was written by the user's agent on their behalf")]).toEqual([file, true]);
    expect([file, prompt.includes("Only the words it puts in quotation marks are the user's own")]).toEqual([file, true]);
  }
});


test("a pick tells the model which question it answers; a typed message is its words alone", () => {
  const text = (content: Extract<AgentMessage["content"], { type: "text" }>) =>
    (prepareAiSdkMessages([agentMessage({ role: "user", content })], { includeImages: false })[0] as { content: string }).content;
  expect(text({ type: "text", text: "Push now", metadata: { answers: [{ id: "q_1", question: "Push the branch?" }] } }))
    .toBe('[Answer to your question "Push the branch?"]\nPush now');
  expect(text({ type: "text", text: "Yes to both", metadata: { answers: [{ id: "q_1", question: "Push the branch?" }, { id: "q_2", question: "Tag it too?" }] } }))
    .toBe('[Answer to your question "Push the branch?"]\n[Answer to your question "Tag it too?"]\nYes to both');
  expect(text({ type: "text", text: "Push it." })).toBe("Push it.");
  // A question of several lines is named on one, and a long one is cut.
  expect(text({ type: "text", text: "Yes", metadata: { answers: [{ id: "q_1", question: "Push the branch?\n\nIt is rebased." }] } }))
    .toBe('[Answer to your question "Push the branch? It is rebased."]\nYes');
  const long = text({ type: "text", text: "Yes", metadata: { answers: [{ id: "q_1", question: "x".repeat(500) }] } });
  expect(long).toBe(`[Answer to your question "${"x".repeat(199)}…"]\nYes`);
  // A mark whose question's words are missing still says it is an answer.
  expect(text({ type: "text", text: "Yes", metadata: { answers: [{ id: "q_1" }] } })).toBe("[Answer to your question]\nYes");
});

// A message that waited behind the asker's running turn lands after whatever
// the turn did meanwhile. Where that was a new question, the asker reads the
// user's earlier words right after it: it is told they are not its answer.
test("a message written before a question was asked says so to the model, ahead of the user's words", () => {
  const text = (message: Partial<AgentMessage> & Pick<AgentMessage, "content">) =>
    (prepareAiSdkMessages([agentMessage({ role: "user", ...message })], { includeImages: false })[0] as { content: string }).content;
  const before = (questions: Array<{ id: string; question?: string }>) => ({ openWhenWritten: [], writtenBefore: questions });
  expect(text({ content: { type: "text", text: "Yes, go ahead with the rename.", metadata: before([{ id: "q_2", question: "Push to main now?" }]) } }))
    .toBe('[Written before you asked "Push to main now?"; it does not answer that]\nYes, go ahead with the rename.');
  // One line for each question asked since; several lines of a question on one, a long one cut.
  expect(text({ content: { type: "text", text: "Yes", metadata: before([{ id: "q_2", question: "Push to main now?\n\nIt is rebased." }, { id: "q_3", question: "x".repeat(500) }]) } }))
    .toBe(`[Written before you asked "Push to main now? It is rebased."; it does not answer that]\n[Written before you asked "${"x".repeat(199)}…"; it does not answer that]\nYes`);
  // The note of what the user told a worker is read the same way.
  const note = text({
    source: "feature-message",
    content: { type: "text", text: "The user wrote to your worker…", metadata: { ...featureMessageNoteMetadata({ featureId: "f1", featureName: "evict", by: "user", text: "Rename it.", attachments: 0 }), ...before([{ id: "q_2", question: "Push to main now?" }]) } }
  });
  expect(note).toBe('[Written before you asked "Push to main now?"; it does not answer that]\nThe user wrote to your worker…');
  // Nothing asked since, or a mark that names no question's words: the message is its words alone.
  expect(text({ content: { type: "text", text: "Yes", metadata: { openWhenWritten: ["q_1"] } } })).toBe("Yes");
  expect(text({ content: { type: "text", text: "Yes", metadata: before([{ id: "q_2" }]) } })).toBe("Yes");
});

// A step's stored provider state (reasoning items, encrypted content,
// signatures) is replayed only to the model id that wrote it; any other
// model gets the step's visible text and tool calls.
function writtenStep(writtenBy?: { provider: string; model: string }) {
  return agentMessage({
    id: "assistant-1",
    role: "assistant",
    content: {
      type: "assistant",
      text: "Visible answer",
      ...(writtenBy ? { writtenBy } : {}),
      sdkAssistantMessages: [{
        role: "assistant",
        content: [
          { type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-reasoning" } } },
          { type: "text", text: "Visible answer" }
        ]
      }]
    }
  });
}
const plainStep: ModelMessage[] = [{ role: "assistant", content: [{ type: "text", text: "Visible answer" }] }];

test("prepareAiSdkMessages: a step's provider state goes only to the model id that wrote it, whatever the provider", () => {
  const byGpt = writtenStep({ provider: "provider-1", model: "openai/gpt-6.1-sol" });
  const replayed = prepareAiSdkMessages([byGpt], { includeImages: true, replayTo: "openai/gpt-6.1-sol" });
  expect(JSON.stringify(replayed)).toContain("encrypted-reasoning");
  // The same model id through another provider: the same.
  expect(JSON.stringify(prepareAiSdkMessages([writtenStep({ provider: "kilo", model: "openai/gpt-6.1-sol" })], { includeImages: true, replayTo: "openai/gpt-6.1-sol" })))
    .toContain("encrypted-reasoning");
  // Another model id: the visible step only.
  expect(prepareAiSdkMessages([byGpt], { includeImages: true, replayTo: "x-ai/grok-4.7" })).toEqual(plainStep);
  // A step from before steps said who wrote them counts as another model's.
  expect(prepareAiSdkMessages([writtenStep()], { includeImages: true, replayTo: "openai/gpt-6.1-sol" })).toEqual(plainStep);
  // No model named: as before, the stored state.
  expect(JSON.stringify(prepareAiSdkMessages([writtenStep()], { includeImages: true }))).toContain("encrypted-reasoning");
});


test("a user message with mentions reads their lines before the user's words", () => {
  const text = (content: Extract<AgentMessage["content"], { type: "text" }>) =>
    (prepareAiSdkMessages([agentMessage({ role: "user", content })], { includeImages: false })[0] as { content: string }).content;
  const A = { kind: "thread", id: "thr_a", label: "Parser errors" };
  expect(text({ type: "text", text: "Follow up on @Parser errors", metadata: mentionsMetadata([A]) }))
    .toBe('[Mentioned thread "Parser errors", threadId thr_a; read it with read_thread]\nFollow up on @Parser errors');
  // With an answer mark too: the answer line first, then the mention.
  expect(text({ type: "text", text: "Yes, @Parser errors", metadata: { ...mentionsMetadata([A]), answers: [{ id: "q_1", question: "Which one?" }] } }))
    .toBe('[Answer to your question "Which one?"]\n[Mentioned thread "Parser errors", threadId thr_a; read it with read_thread]\nYes, @Parser errors');
});

// Message times: each incoming message opens with the time it arrived; a
// tool result that finished long after the last time shown ends with its own.

const ZONE = { timeZone: "Asia/Shanghai" };

function contentOf(message: ModelMessage | undefined): string {
  if (!message) throw new Error("no message");
  if (typeof message.content === "string") return message.content;
  const first = message.content[0];
  if (first && "text" in first && typeof first.text === "string") return first.text;
  throw new Error(`no text in a ${message.role} message`);
}

function callAndResult(n: number, at: string, result: unknown, extra: Partial<AgentMessage> = {}): AgentMessage[] {
  return [
    agentMessage({
      id: `call-${n}`,
      seq: n * 2,
      role: "assistant",
      source: "self",
      createdAt: at,
      content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `tc-${n}`, toolName: "bash", args: { command: "make" } }] }
    }),
    agentMessage({
      id: `result-${n}`,
      seq: n * 2 + 1,
      role: "tool",
      source: "self",
      createdAt: at,
      content: { type: "tool_result", toolCallId: `tc-${n}`, toolName: "bash", result, isError: false },
      ...extra
    })
  ];
}

test("message times: an incoming message opens with the time it arrived, before its own header", () => {
  const at = "2026-10-23T13:45:00.000Z";
  const plain = agentMessage({ role: "user", createdAt: at, content: { type: "text", text: "Fix the timeout" } });
  const relayed = agentMessage({ role: "user", createdAt: at, content: { type: "text", text: "Fix the timeout", relay: { by: "global", spoken: false, handoffId: "h", name: "Atlas" } } });
  const worker = agentMessage({
    role: "user",
    source: "feature-message",
    createdAt: at,
    content: { type: "text", text: "Done", metadata: featureMessageReplyMetadata({ featureId: "f-1", featureName: "Checkout" }) }
  });
  const task = agentMessage({
    role: "user",
    source: "subagent-task",
    createdAt: at,
    content: { type: "text", text: "Read the logs", metadata: subagentTaskMetadata({ taskId: "task_1", askedBy: "Release 0.72" }) }
  });
  expect(prepareAiSdkMessages([plain], { includeImages: false, ...ZONE })).toEqual([{ role: "user", content: "[Fri 2026-10-23 21:45 +08:00]\nFix the timeout" }]);
  expect(contentOf(prepareAiSdkMessages([relayed], { includeImages: false, ...ZONE })[0])).toBe("[Fri 2026-10-23 21:45 +08:00]\n[via Atlas, the user's agent]\nFix the timeout");
  expect(contentOf(prepareAiSdkMessages([worker], { includeImages: false, ...ZONE })[0])).toBe("[Fri 2026-10-23 21:45 +08:00]\n[Worker message from Checkout]\nDone");
  expect(contentOf(prepareAiSdkMessages([task], { includeImages: false, ...ZONE })[0])).toBe("[Fri 2026-10-23 21:45 +08:00]\n[Task from Release 0.72]\nRead the logs");
});

test("message times: a message with images opens with it too", () => {
  const at = "2026-10-23T13:45:00.000Z";
  const withImage = agentMessage({
    role: "user",
    createdAt: at,
    content: {
      type: "text",
      text: "This screen",
      attachments: [{ type: "image", id: "img-1", name: "shot.png", mediaType: "image/png", data: "AAAA", sizeBytes: 3 }]
    }
  });
  const prepared = prepareAiSdkMessages([withImage], { includeImages: true, ...ZONE })[0];
  expect(contentOf(prepared)).toBe("[Fri 2026-10-23 21:45 +08:00]\nThis screen");
  expect(Array.isArray(prepared?.content) && prepared.content.some((part) => part.type === "file")).toBe(true);
});

test("message times: a message that waited reads the time it arrived, not the time it joined", () => {
  const waited = agentMessage({
    role: "user",
    createdAt: "2026-10-23T13:45:00.000Z",
    content: { type: "text", text: "Saved the form", arrivedAt: "2026-10-23T01:00:00.000Z" }
  });
  expect(contentOf(prepareAiSdkMessages([waited], { includeImages: false, ...ZONE })[0])).toBe("[Fri 2026-10-23 09:00 +08:00]\nSaved the form");
});

test("message times: runtime context and compaction summaries carry none", () => {
  const at = "2026-10-23T13:45:00.000Z";
  const digest = agentMessage({
    role: "user",
    source: "runtime-context",
    createdAt: at,
    content: { type: "text", text: "[initial_context]\nThreads: none", metadata: { runtimeContextKind: "initial" } }
  });
  const summary = agentMessage({
    id: "sum-1",
    seq: 2,
    role: "user",
    source: "compression",
    createdAt: at,
    content: { type: "summary", summary: "Earlier work", replacedRange: [1, 1], replacedCount: 1, retained: [] }
  });
  expect(prepareAiSdkMessages([digest, summary], { includeImages: false, ...ZONE })).toEqual([
    { role: "user", content: "[initial_context]\nThreads: none" },
    { role: "user", content: "[Compressed conversation summary]\nEarlier work" }
  ]);
});

test("message times: a tool result five minutes or more after the last time shown ends with its own", () => {
  const messages = [
    agentMessage({ role: "user", createdAt: "2026-10-23T13:45:00.000Z", content: { type: "text", text: "Build it" } }),
    ...callAndResult(1, "2026-10-23T13:49:59.999Z", "first"),
    ...callAndResult(2, "2026-10-23T13:50:00.000Z", "second"),
    ...callAndResult(3, "2026-10-23T13:54:59.000Z", "third"),
    ...callAndResult(4, "2026-10-23T13:55:30.000Z", "fourth")
  ];
  const prepared = prepareAiSdkMessages(messages, { includeImages: false, ...ZONE });
  expect(toolOutputOf(prepared[2], "text").value).toBe("first");
  expect(toolOutputOf(prepared[4], "text").value).toBe("second\n\n[Fri 2026-10-23 21:50 +08:00]");
  expect(toolOutputOf(prepared[6], "text").value).toBe("third");
  expect(toolOutputOf(prepared[8], "text").value).toBe("fourth\n\n[Fri 2026-10-23 21:55 +08:00]");
});

test("message times: a structured, failed or image result keeps its kind of output and ends with the time", () => {
  const start = agentMessage({ role: "user", createdAt: "2026-10-23T13:00:00.000Z", content: { type: "text", text: "Go" } });
  const structured = prepareAiSdkMessages([start, ...callAndResult(1, "2026-10-23T13:10:00.000Z", { exitCode: 0 })], { includeImages: false, ...ZONE });
  expect(toolOutputOf(structured[2], "text").value).toBe("{\"exitCode\":0}\n\n[Fri 2026-10-23 21:10 +08:00]");

  const failed = prepareAiSdkMessages([start, ...callAndResult(1, "2026-10-23T13:10:00.000Z", undefined, {
    content: { type: "tool_result", toolCallId: "tc-1", toolName: "bash", result: undefined, isError: true, error: "exit 1" }
  })], { includeImages: false, ...ZONE });
  expect(toolOutputOf(failed[2], "error-text").value).toBe("exit 1\n\n[Fri 2026-10-23 21:10 +08:00]");

  const image = {
    type: "view_image_result",
    message: "Viewed shot.png",
    image: { type: "image", id: "img-1", name: "shot.png", displayPath: "shot.png", mediaType: "image/png", data: "AAAA", sizeBytes: 3 }
  };
  const viewed = prepareAiSdkMessages([start, ...callAndResult(1, "2026-10-23T13:10:00.000Z", image)], { includeImages: true, ...ZONE });
  const parts = toolOutputOf(viewed[2], "content").value;
  expect(parts.at(-1)).toEqual({ type: "text", text: "[Fri 2026-10-23 21:10 +08:00]" });
  expect(parts.some((part) => part.type === "file")).toBe(true);
});

test("message times: a late message showing an earlier time does not set the clock back", () => {
  const messages = [
    agentMessage({ role: "user", createdAt: "2026-10-23T13:45:00.000Z", content: { type: "text", text: "Build it" } }),
    ...callAndResult(1, "2026-10-23T13:52:00.000Z", "built"),
    agentMessage({ id: "late", seq: 4, role: "user", createdAt: "2026-10-23T13:53:00.000Z", content: { type: "text", text: "Saved", arrivedAt: "2026-10-23T13:00:00.000Z" } }),
    ...callAndResult(3, "2026-10-23T13:56:00.000Z", "tested")
  ];
  const prepared = prepareAiSdkMessages(messages, { includeImages: false, ...ZONE });
  expect(toolOutputOf(prepared[2], "text").value).toBe("built\n\n[Fri 2026-10-23 21:52 +08:00]");
  expect(contentOf(prepared[3])).toBe("[Fri 2026-10-23 21:00 +08:00]\nSaved");
  expect(toolOutputOf(prepared[5], "text").value).toBe("tested");
});

test("message times: the first tool result after a compaction summary shows the time", () => {
  const messages = [
    agentMessage({
      id: "sum-1",
      seq: 1,
      role: "user",
      source: "compression",
      createdAt: "2026-10-23T13:40:00.000Z",
      content: { type: "summary", summary: "Earlier work", replacedRange: [1, 1], replacedCount: 1, retained: [] }
    }),
    ...callAndResult(1, "2026-10-23T13:41:00.000Z", "built")
  ];
  const prepared = prepareAiSdkMessages(messages, { includeImages: false, ...ZONE });
  expect(toolOutputOf(prepared[2], "text").value).toBe("built\n\n[Fri 2026-10-23 21:41 +08:00]");
});

// Kilo's Chat models keep their reasoning as OpenRouter's reasoning_details on
// the assistant message (OpenRouter's SDK); the same rule carries them.
test("prepareAiSdkMessages: OpenRouter's reasoning_details go back only to the model id that wrote them", () => {
  const step = agentMessage({
    id: "assistant-2",
    role: "assistant",
    content: {
      type: "assistant",
      text: "Visible answer",
      writtenBy: { provider: "kilo", model: "vendor/chat-model" },
      sdkAssistantMessages: [{
        role: "assistant",
        content: [{ type: "text", text: "Visible answer" }],
        providerOptions: { openrouter: { reasoning_details: [{ type: "reasoning.text", text: "thinking-text" }] } }
      }]
    }
  });
  expect(JSON.stringify(prepareAiSdkMessages([step], { includeImages: true, replayTo: "vendor/chat-model" }))).toContain("thinking-text");
  expect(prepareAiSdkMessages([step], { includeImages: true, replayTo: "vendor/other-model" })).toEqual(plainStep);
});

// A model that needs its reasoning back (DeepSeek: "The `reasoning_text` in
// the thinking mode must be passed back") refuses a step that has none of
// its own. A step written by another model goes to such a model with a
// one-space reasoning placeholder; its own steps, older ones included, never.
const DS = "deepseek/deepseek-flash";
function stepWithCall(writtenBy?: { provider: string; model: string }, sdkAssistantMessages?: unknown[]) {
  return [
    agentMessage({
      id: "assistant-ph", role: "assistant",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-ph", toolName: "bash", args: { command: "pwd" } }],
        ...(writtenBy ? { writtenBy } : {}),
        ...(sdkAssistantMessages ? { sdkAssistantMessages } : {})
      } as never
    }),
    agentMessage({ id: "tool-ph", seq: 2, role: "tool", content: { type: "tool_result", toolCallId: "call-ph", toolName: "bash", result: "/p" } })
  ];
}
const PLACEHOLDER = { type: "reasoning", text: " " };
const firstPart = (messages: ModelMessage[]) => (messages[0] as { content: unknown[] }).content[0];

test("a step by another model gets the placeholder for a model that needs it", () => {
  const out = prepareAiSdkMessages(stepWithCall({ provider: "kilo", model: "vendor/other" }), { includeImages: true, replayTo: DS, reasoningPlaceholderFor: DS });
  expect((out[0] as { content: unknown[] }).content).toEqual([PLACEHOLDER, { type: "tool-call", toolCallId: "call-ph", toolName: "bash", input: { command: "pwd" } }]);
});

test("a step with no writtenBy counts as another model's", () => {
  const out = prepareAiSdkMessages(stepWithCall(), { includeImages: true, replayTo: DS, reasoningPlaceholderFor: DS });
  expect(firstPart(out)).toEqual(PLACEHOLDER);
});

test("an older step of the same model gets no placeholder", () => {
  const stored = [{ role: "assistant", content: [
    { type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_old", reasoningEncryptedContent: null } } },
    { type: "tool-call", toolCallId: "call-ph", toolName: "bash", input: { command: "pwd" } }
  ] }];
  const out = prepareAiSdkMessages(stepWithCall({ provider: "provider-1", model: DS }, stored), { includeImages: true, replayTo: DS, reasoningPlaceholderFor: DS });
  expect(out[0]).toEqual(stored[0] as never);
  expect(JSON.stringify(out)).not.toContain('"text":" "');
});

test("no option, no placeholder", () => {
  const out = prepareAiSdkMessages(stepWithCall({ provider: "kilo", model: "vendor/other" }), { includeImages: true, replayTo: DS });
  expect(JSON.stringify(out)).not.toContain('"text":" "');
});

test("local compaction leaves provider state out but keeps the rule", () => {
  const mine = stepWithCall({ provider: "provider-1", model: DS });
  const theirs = stepWithCall({ provider: "kilo", model: "vendor/other" }).map((m, i) => ({ ...m, id: `${m.id}-b`, seq: 3 + i, content: m.role === "assistant" ? { ...(m.content as object), toolCalls: [{ toolCallId: "call-b", toolName: "bash", args: {} }] } : { ...(m.content as object), toolCallId: "call-b" } })) as AgentMessage[];
  const out = prepareAiSdkMessages([...mine, ...theirs], { includeImages: true, includeProviderState: false, reasoningPlaceholderFor: DS });
  const assistants = out.filter((m) => m.role === "assistant") as Array<{ content: unknown[] }>;
  expect(assistants.map((m) => JSON.stringify(m.content[0]) === JSON.stringify(PLACEHOLDER))).toEqual([false, true]);
});
