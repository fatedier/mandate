import { z } from "zod";

export const params = z.object({ projectId: z.string().optional() });
