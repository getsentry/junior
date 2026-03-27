import { describe, expect, it, vi } from "vitest";
import {
  decideSubscribedThreadReply,
  getSubscribedReplyPreflightDecision,
  SubscribedReplyReason,
  type SubscribedDecisionInput,
} from "@/chat/services/subscribed-decision";

function makeInput(
  overrides: Partial<SubscribedDecisionInput> = {},
): SubscribedDecisionInput {
  return {
    rawText: "hello",
    text: "hello",
    hasAttachments: false,
    isExplicitMention: false,
    context: {},
    ...overrides,
  };
}

describe("decideSubscribedThreadReply", () => {
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

  it("replies directly to explicit mentions in subscribed threads", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: true,
        confidence: 0.95,
        reason: "direct mention asking junior for help",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ isExplicitMention: true }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.ExplicitMention,
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("sends acknowledgment text to the classifier instead of short-circuiting", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: false,
        confidence: 0.95,
        reason: "acknowledgment",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "thanks!", rawText: "thanks!" }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "acknowledgment",
    });
    expect(completeObject).toHaveBeenCalled();
  });

  it("sends follow-up questions to the classifier instead of short-circuiting", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: true,
        confidence: 0.95,
        reason: "follow-up to assistant response",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
        text: "what did you just say about the budget?",
        rawText: "what did you just say about the budget?",
        conversationContext:
          "<thread-transcript>\n[assistant] junior: Budget is due Friday.\n</thread-transcript>",
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.Classifier,
      reasonDetail: "follow-up to assistant response",
    });
    expect(completeObject).toHaveBeenCalled();
  });

  it("does not suppress acknowledgment text when it is an explicit mention", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: true,
        confidence: 0.95,
        reason: "direct mention acknowledgment",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
        text: "thanks!",
        rawText: "thanks!",
        isExplicitMention: true,
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.ExplicitMention,
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("still honors explicit stop instructions before mention short-circuiting", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
        rawText: "<@U_APP> stop watching or participating in this thread",
        text: "stop watching or participating in this thread",
        isExplicitMention: true,
      }),
      completeObject: vi.fn(),
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      shouldUnsubscribe: true,
      reason: SubscribedReplyReason.ThreadOptOut,
      reasonDetail: "explicit stop instruction",
    });
  });

  it("skips leading slack mentions addressed to another party before classifier", async () => {
    const completeObject = vi.fn();
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
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

  it("skips empty message without attachments", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "   ", rawText: "   " }),
      completeObject: vi.fn(),
      logClassifierFailure: vi.fn(),
    });

    expect(decision.reason).toBe(SubscribedReplyReason.EmptyMessage);
    expect(decision.shouldReply).toBe(false);
  });

  it("replies to attachment-only message", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "", rawText: "", hasAttachments: true }),
      completeObject: vi.fn(),
      logClassifierFailure: vi.fn(),
    });

    expect(decision.reason).toBe(SubscribedReplyReason.AttachmentOnly);
    expect(decision.shouldReply).toBe(true);
  });

  it("uses classifier and maps false decision to side conversation", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "some new text", rawText: "some new text" }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: false,
          confidence: 0.95,
          reason: "status chatter",
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision.reason).toBe(SubscribedReplyReason.SideConversation);
    expect(decision.reasonDetail).toBe("status chatter");
    expect(decision.shouldReply).toBe(false);
  });

  it("maps classifier unsubscribe decisions to thread opt-out", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
        text: "please stop participating here",
        rawText: "please stop participating here",
      }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: false,
          should_unsubscribe: true,
          confidence: 0.95,
          reason: "user asked junior to stop participating in the thread",
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      shouldUnsubscribe: true,
      reason: SubscribedReplyReason.ThreadOptOut,
      reasonDetail: "user asked junior to stop participating in the thread",
    });
  });

  it("accepts long classifier reasons without failing schema parsing", async () => {
    const longReason =
      "User is making a casual comment about Junior, not asking for assistance or requesting Junior to perform a task. This is side conversation and not a direct request for help.";
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "some new text", rawText: "some new text" }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: false,
          confidence: 0.95,
          reason: longReason,
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision.reason).toBe(SubscribedReplyReason.SideConversation);
    expect(decision.reasonDetail).toBe(longReason);
    expect(decision.shouldReply).toBe(false);
  });

  it("uses classifier and rejects low-confidence true", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "some new text", rawText: "some new text" }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: true,
          confidence: 0.75,
          reason: "maybe follow-up",
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision.reason).toBe(SubscribedReplyReason.LowConfidence);
    expect(decision.shouldReply).toBe(false);
  });

  it("uses classifier and returns reply on high confidence", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "some new text", rawText: "some new text" }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: true,
          confidence: 0.95,
          reason: "direct question",
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision.reason).toBe(SubscribedReplyReason.Classifier);
    expect(decision.reasonDetail).toBe("direct question");
    expect(decision.shouldReply).toBe(true);
  });

  it("fails closed on classifier errors", async () => {
    const logClassifierFailure = vi.fn();
    const input = makeInput({
      text: "some new text",
      rawText: "some new text",
    });
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input,
      completeObject: vi.fn(async () => {
        throw new Error("router failed");
      }),
      logClassifierFailure,
    });

    expect(decision.reason).toBe(SubscribedReplyReason.ClassifierError);
    expect(decision.shouldReply).toBe(false);
    expect(logClassifierFailure).toHaveBeenCalledWith(expect.any(Error), input);
  });
});
