import { describe, expect, it, vi } from "vitest";
import {
  decideSubscribedThreadReply,
  SubscribedReplyReason,
} from "@/chat/services/subscribed-decision";
import { makeSubscribedInput } from "../../fixtures/subscribed-decision";

describe("subscribed thread short-circuit routing", () => {
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
      input: makeSubscribedInput({ isExplicitMention: true }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.ExplicitMention,
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("short-circuits pure acknowledgment text without calling the classifier", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: true,
        confidence: 1,
        reason: "this should never be used",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({ text: "thanks!", rawText: "thanks!" }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "acknowledgment",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("short-circuits immediate directed follow-ups after the assistant replied", async () => {
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
      input: makeSubscribedInput({
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
      reason: SubscribedReplyReason.DirectedFollowUp,
      reasonDetail: "immediate directed follow-up cue",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("short-circuits immediate terse clarifications after the assistant replied", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: false,
        confidence: 0.95,
        reason: "this should never be used",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "Which one?",
        rawText: "Which one?",
        conversationContext:
          "<thread-transcript>\n[assistant] junior: The deploy changed billing, auth, and the API gateway.\n</thread-transcript>",
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.DirectedFollowUp,
      reasonDetail: "immediate terse clarification",
    });
    expect(completeObject).not.toHaveBeenCalled();
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
      input: makeSubscribedInput({
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
      input: makeSubscribedInput({
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

  it("skips empty message without attachments", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({ text: "   ", rawText: "   " }),
      completeObject: vi.fn(),
      logClassifierFailure: vi.fn(),
    });

    expect(decision.reason).toBe(SubscribedReplyReason.EmptyMessage);
    expect(decision.shouldReply).toBe(false);
  });

  it("accepts lower-confidence clarification when junior was the last speaker", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "which one?",
        rawText: "which one?",
        conversationContext:
          "<thread-transcript>\n[assistant] junior: The deploy touched billing, auth, and API gateway.\n</thread-transcript>",
      }),
      completeObject: vi.fn(async () => ({
        object: {
          should_reply: true,
          confidence: 0.65,
          reason: "immediate clarification for assistant",
        },
      })),
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.DirectedFollowUp,
      reasonDetail: "immediate terse clarification",
    });
  });

  it("skips a generic immediate question that does not clearly turn back to junior", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: true,
        confidence: 1,
        reason: "this should never be used",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "is that the right approach?",
        rawText: "is that the right approach?",
        conversationContext:
          "<thread-transcript>\n[assistant] junior: The deploy changed billing and auth.\n</thread-transcript>",
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "generic immediate side conversation",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("skips long 'what about' topic continuation after junior speaks", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        should_reply: true,
        confidence: 1,
        reason: "this should never be used",
      },
    }));
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeSubscribedInput({
        text: "what about the billing worker timeline?",
        rawText: "what about the billing worker timeline?",
        conversationContext:
          "<thread-transcript>\n[assistant] junior: The billing worker handles invoice retries.\n</thread-transcript>",
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    expect(decision).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "generic immediate side conversation",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });
});
