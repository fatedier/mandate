import { expect, test } from "bun:test";
import {
  featureEventStatus,
  firstFeatureEventFromCallMetadata
} from "../src/client/lib/feature-event-source.js";

test("feature-event source helpers accept limit_reached events without taskId", () => {
  const event = firstFeatureEventFromCallMetadata({
    featureEvents: [{
      type: "feature_event",
      kind: "limit_reached",
      featureId: "feat-1",
      workItemId: "wi-1",
      label: "Feature wake limit reached",
      summary: "Hit the step budget.",
      stepCount: 201
    }]
  });

  expect(event).toMatchObject({
    type: "feature_event",
    kind: "limit_reached",
    featureId: "feat-1",
    label: "Feature wake limit reached",
    stepCount: 201
  });
  expect(event!.taskId).toBeUndefined();
  expect(featureEventStatus(event!)).toBe("limit reached");
});
