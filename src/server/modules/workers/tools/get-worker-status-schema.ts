import { z } from "zod";

export const params = z.object({ workerId: z.string().min(1) });
