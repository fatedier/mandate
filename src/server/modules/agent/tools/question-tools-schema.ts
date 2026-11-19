import { z } from "zod";
import { QUESTION_MAX_CHARS, OPTION_LABEL_MAX_CHARS, OPTION_DESCRIPTION_MAX_CHARS } from "../../../../shared/questions.js";

export const optionSchema = z.object({
  label: z.string().trim().min(1).max(OPTION_LABEL_MAX_CHARS).refine((label) => !/[\r\n]/.test(label), "a label is one line")
    .describe("The answer in a few words. Picking it sends these words as the user's message."),
  description: z.string().trim().max(OPTION_DESCRIPTION_MAX_CHARS).optional().describe("One line on what picking it means.")
}).strict();

export const askParams = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX_CHARS).describe("The question as the user will read it, in their language. Markdown, drawn as your replies are: put paths, commands and patterns in backticks."),
  // A model that fills every field sends an empty list for "none": that is
  // no options, not a mistake to send back.
  options: z.array(optionSchema).max(4).refine((options) => options.length !== 1, "give two to four options, or none")
    // A pick is sent as its label: two options that read alike could not be told apart afterwards.
    .refine((options) => new Set(options.map((o) => o.label.toLowerCase())).size === options.length, "each option needs its own label")
    .optional().describe("Two to four suggested answers, the recommended one first. Leave out for an open question.")
}).strict();

export const withdrawParams = z.object({
  questionId: z.string().trim().min(1).describe("The id `ask_user` returned; your open questions are also listed in the runtime context.")
}).strict();
