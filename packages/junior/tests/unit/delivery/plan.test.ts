import { describe, expect, it } from "vitest";
import { buildReplyDeliveryPlan } from "@/chat/services/reply-delivery-plan";

describe("buildReplyDeliveryPlan", () => {
  it("returns channel_only mode when explicit channel intent and channel post succeeds", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: true,
        channelPostPerformed: true,
        hasFiles: true,
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
        explicitChannelPostIntent: false,
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
