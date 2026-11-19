import type { MandateModule } from "../module.js";
import { initializeToolReviewSchema } from "./streak-store.js";

export const toolReviewModule: MandateModule = {
  id: "tool-review",
  schema: [initializeToolReviewSchema]
};
