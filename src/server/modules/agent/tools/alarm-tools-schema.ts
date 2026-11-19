import { z } from "zod";

// One tool, one time field. Earlier designs (mode discriminator + optional
// delayMs/atTime; or two split tools schedule_wake_in/_at) tripped up
// LLMs that either misused the discriminator or had to pick between
// near-identical tool names.
export const scheduleParams = z.object({
  when: z.string().min(1).describe(
    "When to wake. Use a relative duration like '30m', '2h', '1d', or an absolute ISO time with timezone like '2026-05-22T10:30:00+08:00'. Range: 1 second to 30 days from now."
  ),
  note: z.string().min(1).max(600).describe(
    "Why you're scheduling this wake — included in the alarm message so future-you knows what to do."
  )
});

export const cancelParams = z.object({
  alarmId: z.string().min(1)
});

export const listParams = z.object({
  includeFired: z.boolean().optional()
});
