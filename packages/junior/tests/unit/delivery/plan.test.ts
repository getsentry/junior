import { describe, expect, it } from "vitest";
import { buildReplyDeliveryPlan } from "@/chat/services/reply-delivery-plan";

describe("buildReplyDeliveryPlan", () => {
  it("returns channel_only mode when a channel side effect owns the reply", () => {
    expect(
      buildReplyDeliveryPlan({
        channelOnlySideEffect: true,
        channelPostPerformed: true,
        hasFiles: false,
      }),
    ).toEqual({
      mode: "channel_only",
      postThreadText: false,
      attachFiles: "none",
    });
  });

  it("keeps files inline with finalized thread replies", () => {
    expect(
      buildReplyDeliveryPlan({
        channelOnlySideEffect: false,
        channelPostPerformed: false,
        hasFiles: true,
      }),
    ).toEqual({
      mode: "thread",
      postThreadText: true,
      attachFiles: "inline",
    });
  });
});
