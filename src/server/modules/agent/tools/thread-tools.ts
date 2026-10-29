import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { ManagerThreadService } from "../manager-threads.js";

const params = z.object({
  title: z.string().min(1).max(80).describe(
    "2-6 words naming what this thread is about, e.g. \"payments v2 release\". Plain words, no quotes or emoji."
  )
}).strict();

/** The manager names the thread it is talking in, and renames it when the
 *  user moves it on to another task. A name the user set stays.
 *  Forgetting is safe: an unnamed thread shows the first line the user
 *  wrote. */
export function buildNameThreadTool(threads: ManagerThreadService): ToolDefinition<z.infer<typeof params>, string> {
  return {
    name: "name_thread",
    description:
      "Name this conversation thread in 2-6 words: in your first reply of a new thread, " +
      "and again when the user moves it on to a different task. A name the user set is kept.",
    parameters: params,
    handler: async (input, ctx) => {
      const result = threads.nameByAgent(ctx.threadId, input.title);
      if ("error" in result) throw new Error(result.error);
      switch (result.kind) {
        case "named": return `Named this thread "${result.title}".`;
        case "renamed": return `Renamed this thread "${result.title}" (was "${result.previous}").`;
        case "same": return `This thread is already named "${result.title}".`;
        case "user": return `The user named this thread "${result.title}"; it stays.`;
      }
    }
  };
}
