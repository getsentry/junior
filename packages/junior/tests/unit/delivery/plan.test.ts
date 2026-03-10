import { describe, expect, it } from "vitest";
import {
  buildReplyDeliveryPlan,
  isPotentialRedundantReactionAckText,
} from "@/chat/delivery/plan";

describe("buildReplyDeliveryPlan", () => {
  it("returns channel_only mode when explicit channel intent and channel post succeeds", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: true,
        channelPostPerformed: true,
        reactionPerformed: false,
        hasFiles: true,
        streamingThreadReply: true,
      }),
    ).toEqual({
      mode: "channel_only",
      ack: "none",
      postThreadText: false,
      attachFiles: "none",
    });
  });

  it("prefers followup file delivery for streamed thread replies", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: false,
        channelPostPerformed: false,
        reactionPerformed: false,
        hasFiles: true,
        streamingThreadReply: true,
      }),
    ).toEqual({
      mode: "thread",
      ack: "none",
      postThreadText: true,
      attachFiles: "followup",
    });
  });

  it("prefers inline file delivery for non-streamed thread replies", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: false,
        channelPostPerformed: false,
        reactionPerformed: false,
        hasFiles: true,
        streamingThreadReply: false,
      }),
    ).toEqual({
      mode: "thread",
      ack: "none",
      postThreadText: true,
      attachFiles: "inline",
    });
  });

  it("captures reaction ack strategy when reaction tool is used", () => {
    expect(
      buildReplyDeliveryPlan({
        explicitChannelPostIntent: false,
        channelPostPerformed: false,
        reactionPerformed: true,
        hasFiles: false,
        streamingThreadReply: true,
      }),
    ).toEqual({
      mode: "thread",
      ack: "reaction",
      postThreadText: true,
      attachFiles: "none",
    });
  });

  it("treats partial redundant ack text as a buffered prefix", () => {
    expect(isPotentialRedundantReactionAckText("o")).toBe(true);
    expect(isPotentialRedundantReactionAckText("ok")).toBe(true);
    expect(isPotentialRedundantReactionAckText("do")).toBe(true);
    expect(isPotentialRedundantReactionAckText("do this")).toBe(false);
  });
});
