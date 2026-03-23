import { describe, expect, it } from "vitest";
import {
  buildReplyDeliveryPlan,
  isPotentialRedundantReactionAckText,
} from "@/chat/services/reply-delivery-plan";

describe("buildReplyDeliveryPlan", () => {
  it("returns channel_only mode when explicit channel intent and channel post succeeds", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: true,
        channelPostPerformed: true,
        hasFiles: true,
        streamingThreadReply: true,
      }),
    ).toEqual({
      mode: "channel_only",
      postThreadText: false,
      attachFiles: "none",
    });
  });

  it("prefers followup file delivery for streamed thread replies", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: false,
        channelPostPerformed: false,
        hasFiles: true,
        streamingThreadReply: true,
      }),
    ).toEqual({
      mode: "thread",
      postThreadText: true,
      attachFiles: "followup",
    });
  });

  it("prefers inline file delivery for non-streamed thread replies", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: false,
        channelPostPerformed: false,
        hasFiles: true,
        streamingThreadReply: false,
      }),
    ).toEqual({
      mode: "thread",
      postThreadText: true,
      attachFiles: "inline",
    });
  });

  it("treats partial redundant ack text as a buffered prefix", () => {
    expect(isPotentialRedundantReactionAckText("o")).toBe(true);
    expect(isPotentialRedundantReactionAckText("ok")).toBe(true);
    expect(isPotentialRedundantReactionAckText("do")).toBe(true);
    expect(isPotentialRedundantReactionAckText("do this")).toBe(false);
  });
});
