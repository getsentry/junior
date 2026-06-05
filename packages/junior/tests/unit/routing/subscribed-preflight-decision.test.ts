import { describe, expect, it, vi } from "vitest";
import {
  decideSubscribedThreadReply,
  getSubscribedReplyPreflightDecision,
  SubscribedReplyReason,
} from "@/chat/services/subscribed-decision";
import { makeSubscribedInput } from "../../fixtures/subscribed-decision";

describe("subscribed thread preflight routing", () => {
  it("preflight-skips a leading mention addressed to another named party", () => {
    const decision = getSubscribedReplyPreflightDecision({
      botUserName: "junior",
      rawText: "@Cursor can you take this one?",
      text: "@Cursor can you take this one?",
      isExplicitMention: false,
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.DirectedToOtherParty,
      reasonDetail: "named_mention:Cursor",
    });
  });

  it("does not preflight-skip when junior is also addressed", () => {
    const decision = getSubscribedReplyPreflightDecision({
      botUserName: "junior",
      rawText: "@Cursor and @junior can one of you take this?",
      text: "@Cursor and @junior can one of you take this?",
      isExplicitMention: false,
    });

    expect(decision).toBeUndefined();
  });

  it("does not preflight-skip non-address mentions in the middle of the sentence", () => {
    const decision = getSubscribedReplyPreflightDecision({
      botUserName: "junior",
      rawText: "please ask @Cursor to look at this later",
      text: "please ask @Cursor to look at this later",
      isExplicitMention: false,
    });

    expect(decision).toBeUndefined();
  });

  it("skips leading slack mentions addressed to another party before classifier", async () => {
    const completeObject = vi.fn();
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        rawText: "<@UCURSOR> can you handle this?",
        text: "<@UCURSOR> can you handle this?",
        isExplicitMention: false,
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.DirectedToOtherParty,
      reasonDetail: "slack_mention",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });
});
