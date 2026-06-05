import { describe, expect, it, vi } from "vitest";
import {
  decideSubscribedThreadReply,
  SubscribedReplyReason,
} from "@/chat/services/subscribed-decision";
import { makeSubscribedInput } from "../../fixtures/subscribed-decision";

describe("subscribed thread classifier routing", () => {
  it("routes acknowledgment text with attachments through the classifier", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: false,
        confidence: 0.95,
        reason: "attachment acknowledgment",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "thanks!",
        rawText: "thanks!",
        hasAttachments: true,
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "attachment acknowledgment",
    });
    expect(completeObject).toHaveBeenCalled();
  });

  it("routes attachment-only messages through the classifier instead of auto-replying", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "",
        rawText: "",
        hasAttachments: true,
      }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: false,
          confidence: 0.95,
          reason: "passive attachment",
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "passive attachment",
    });
  });

  it("routes generic immediate attachment follow-ups through the classifier", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: true,
        confidence: 0.95,
        reason: "attachment follow-up",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "can you check on this?",
        rawText: "can you check on this?",
        hasAttachments: true,
        conversationContext:
          "<thread-transcript>\n[assistant] junior: Please upload a screenshot.\n</thread-transcript>",
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.Classifier,
      reasonDetail: "attachment follow-up",
    });
    expect(completeObject).toHaveBeenCalled();
  });

  it("requires stronger confidence after one human takes the floor", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "what about the billing worker timeline?",
        rawText: "what about the billing worker timeline?",
        conversationContext: [
          "<thread-transcript>",
          "[assistant] junior: The deploy changed billing, auth, and the API gateway.",
          "[user] sam: I think we should revert auth first.",
          "</thread-transcript>",
        ].join("\n"),
      }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: true,
          confidence: 0.85,
          reason: "maybe follow-up",
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.LowConfidence,
      reasonDetail: "0.85: maybe follow-up",
    });
  });

  it("uses classifier and maps false decision to side conversation", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "some new text",
        rawText: "some new text",
      }),
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
      input: makeSubscribedInput({
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

  it("uses classifier and rejects low-confidence true", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "some new text",
        rawText: "some new text",
      }),
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
      input: makeSubscribedInput({
        text: "some new text",
        rawText: "some new text",
      }),
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
    const input = makeSubscribedInput({
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
