import { expect, test } from "bun:test";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import {
  MODEL_VISIBLE_WORK_ITEM_SUMMARY_MAX_CHARS,
  MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS,
  prepareAiSdkMessages
} from "../src/server/modules/agent/wake-message-adapter.js";
import { featureMessageReplyMetadata } from "../src/shared/feature-message.js";

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

  const toolMessage = prepareAiSdkMessages(messages, { includeImages: true })[1] as any;
  const output = toolMessage.content[0].output;
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
  expect(output.value.find((part: any) => part.type === "text")?.text).not.toContain(imageBase64);
});

test("prepareAiSdkMessages: omits historical view_image bytes when images are disabled", () => {
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

  const toolMessage = prepareAiSdkMessages(messages, { includeImages: false })[1] as any;
  const output = toolMessage.content[0].output;
  expect(output.type).toBe("text");
  expect(output.value).toContain("does not support image tool-result input");
  expect(JSON.stringify(output)).not.toContain(imageBase64);
});

test("prepareAiSdkMessages: omits view_image bytes when tool-result images are disabled", () => {
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

  const toolMessage = prepareAiSdkMessages(messages, {
    includeImages: true,
    includeToolResultImages: false
  })[1] as any;
  const output = toolMessage.content[0].output;
  expect(output.type).toBe("text");
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

  const toolMessage = prepareAiSdkMessages(messages, { includeImages: true })[1] as any;
  const output = toolMessage.content[0].output;
  expect(output.type).toBe("text");
  expect(output.value).toContain("[truncated 100 chars]");
  expect(output.value.length).toBeLessThan(longOutput.length);
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

  const toolMessage = prepareAiSdkMessages(messages, { includeImages: true })[1] as any;
  const output = toolMessage.content[0].output;
  expect(output.type).toBe("text");
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

test("prepareAiSdkMessages: keeps compact runtime contexts append-only", () => {
  const messages = [
    agentMessage({
      id: "initial-1",
      seq: 1,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[initial_context]\nbase-v1",
        metadata: { runtimeContextKind: "initial", runtimeContextMode: "compact" }
      }
    }),
    agentMessage({
      id: "runtime-1",
      seq: 2,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\ncompact-state-v1",
        metadata: { runtimeContextKind: "update", runtimeContextMode: "compact" }
      }
    }),
    agentMessage({
      id: "user-1",
      seq: 3,
      role: "user",
      content: { type: "text", text: "next" }
    }),
    agentMessage({
      id: "runtime-2",
      seq: 4,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\ncompact-state-v2",
        metadata: { runtimeContextKind: "update", runtimeContextMode: "compact" }
      }
    })
  ];

  const textMessages = prepareAiSdkMessages(messages, { includeImages: true })
    .filter((message): message is { role: "user"; content: string } =>
      message.role === "user" && typeof message.content === "string"
    )
    .map((message) => message.content);

  expect(textMessages).toEqual([
    "[initial_context]\nbase-v1",
    "[runtime_context]\ncompact-state-v1",
    "next",
    "[runtime_context]\ncompact-state-v2"
  ]);
});

test("prepareAiSdkMessages: keeps legacy and compact runtime contexts append-only", () => {
  const messages = [
    agentMessage({
      id: "initial-1",
      seq: 1,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[initial_context]\nbase-v1",
        metadata: { runtimeContextKind: "initial" }
      }
    }),
    agentMessage({
      id: "legacy-runtime-1",
      seq: 2,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\nlegacy-state-v1",
        metadata: { runtimeContextKind: "update" }
      }
    }),
    agentMessage({
      id: "legacy-runtime-2",
      seq: 3,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\nlegacy-state-v2",
        metadata: { runtimeContextKind: "update" }
      }
    }),
    agentMessage({
      id: "compact-runtime-1",
      seq: 4,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\ncompact-state-v1",
        metadata: { runtimeContextKind: "update", runtimeContextMode: "compact" }
      }
    }),
    agentMessage({
      id: "compact-runtime-2",
      seq: 5,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\ncompact-state-v2",
        metadata: { runtimeContextKind: "update", runtimeContextMode: "compact" }
      }
    })
  ];

  const textMessages = prepareAiSdkMessages(messages, { includeImages: true })
    .filter((message): message is { role: "user"; content: string } =>
      message.role === "user" && typeof message.content === "string"
    )
    .map((message) => message.content);

  expect(textMessages).toEqual([
    "[initial_context]\nbase-v1",
    "[runtime_context]\nlegacy-state-v1",
    "[runtime_context]\nlegacy-state-v2",
    "[runtime_context]\ncompact-state-v1",
    "[runtime_context]\ncompact-state-v2"
  ]);
});

test("prepareAiSdkMessages: latest initial context resets older compact runtime updates", () => {
  const messages = [
    agentMessage({
      id: "initial-1",
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[initial_context]\nbase-v1",
        metadata: { runtimeContextKind: "initial", runtimeContextMode: "compact" }
      }
    }),
    agentMessage({
      id: "runtime-1",
      seq: 2,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\ncompact-state-v1",
        metadata: { runtimeContextKind: "update", runtimeContextMode: "compact" }
      }
    }),
    agentMessage({
      id: "initial-2",
      seq: 3,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[initial_context]\nbase-v2",
        metadata: { runtimeContextKind: "initial", runtimeContextMode: "compact" }
      }
    }),
    agentMessage({
      id: "runtime-2",
      seq: 4,
      role: "user",
      source: "runtime-context",
      content: {
        type: "text",
        text: "[runtime_context]\ncompact-state-v2",
        metadata: { runtimeContextKind: "update", runtimeContextMode: "compact" }
      }
    })
  ];

  expect(prepareAiSdkMessages(messages, { includeImages: true })).toEqual([
    { role: "user", content: "[initial_context]\nbase-v2" },
    { role: "user", content: "[runtime_context]\ncompact-state-v2" }
  ]);
});

test("prepareAiSdkMessages: includes feature-event artifact references", () => {
  const messages = [
    agentMessage({
      role: "user",
      source: "feature-event",
      content: {
        type: "feature_event",
        kind: "escalation",
        taskId: "task-1",
        featureId: "feat-1",
        workItemId: null,
        label: "Research",
        summary: "Done",
        signal: "blocked",
        artifacts: [{
          type: "canvas",
          canvasId: "cnv-1",
          title: "Research report",
          path: "/canvas/cnv-1",
          role: "report"
        }]
      }
    })
  ];

  const prepared = prepareAiSdkMessages(messages, { includeImages: true })[0] as any;
  expect(prepared.role).toBe("user");
  expect(prepared.content[0].text).toContain("[feature_event] Research (escalation, signal=blocked): Done");
  expect(prepared.content[0].text).toContain("Artifacts:");
  expect(prepared.content[0].text).toContain("canvas: Research report (/canvas/cnv-1, canvasId=cnv-1, role=report)");
});

test("prepareAiSdkMessages: makes attached work item metadata model-visible", () => {
  const longSummary = "s".repeat(MODEL_VISIBLE_WORK_ITEM_SUMMARY_MAX_CHARS + 20);
  const messages = [
    agentMessage({
      role: "user",
      content: {
        type: "text",
        text: "The sample task is ready for review.",
        metadata: {
          workItemRef: {
            itemId: "wi-1",
            snapshotAt: "2026-01-01T00:00:00.000Z",
            title: "Review the sample feature",
            summary: longSummary,
            projectId: "proj-1",
            featureId: "feat-1",
            phase: "verifying",
            phaseDetail: "waiting for user",
            needsUser: "review"
          }
        }
      }
    })
  ];

  const prepared = prepareAiSdkMessages(messages, { includeImages: true })[0] as any;
  expect(prepared.role).toBe("user");
  expect(prepared.content).toContain("[Attached work item]");
  expect(prepared.content).toContain("id: wi-1");
  expect(prepared.content).toContain("title: Review the sample feature");
  expect(prepared.content).toContain("phase: verifying (waiting for user)");
  expect(prepared.content).toContain("needsUser: review");
  expect(prepared.content).toContain("[truncated 20 chars]");
  expect(prepared.content).toContain("User message:\nThe sample task is ready for review.");
});

test("prepareAiSdkMessages: latest initial context resets older runtime updates", () => {
  const messages = [
    agentMessage({
      id: "initial-1",
      role: "user",
      source: "runtime-context",
      content: { type: "text", text: "[initial_context]\nbase-v1" }
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
      content: { type: "text", text: "[initial_context]\nbase-v2" }
    })
  ];

  expect(prepareAiSdkMessages(messages, { includeImages: true })).toEqual([
    { role: "user", content: "[initial_context]\nbase-v2" }
  ]);
});
