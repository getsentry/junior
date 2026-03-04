import { describe, expect, it, vi } from "vitest";
import {
  decideSubscribedThreadReply,
  SubscribedReplyReason,
  type SubscribedDecisionInput
} from "@/chat/routing/subscribed-decision";

function makeInput(overrides: Partial<SubscribedDecisionInput> = {}): SubscribedDecisionInput {
  return {
    rawText: "hello",
    text: "hello",
    hasAttachments: false,
    isExplicitMention: false,
    context: {},
    ...overrides
  };
}

describe("decideSubscribedThreadReply", () => {
  it("replies immediately for explicit mention", async () => {
    const completeObject = vi.fn();
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ isExplicitMention: true }),
      completeObject,
      logClassifierFailure: vi.fn()
    });

    expect(decision).toEqual({ shouldReply: true, reason: SubscribedReplyReason.ExplicitMention });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("skips empty message without attachments", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "   ", rawText: "   " }),
      completeObject: vi.fn(),
      logClassifierFailure: vi.fn()
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
      logClassifierFailure: vi.fn()
    });

    expect(decision.reason).toBe(SubscribedReplyReason.AttachmentOnly);
    expect(decision.shouldReply).toBe(true);
  });

  it("skips acknowledgment-only text", async () => {
    const completeObject = vi.fn();
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "thanks!", rawText: "thanks!" }),
      completeObject,
      logClassifierFailure: vi.fn()
    });

    expect(decision.reason).toBe(SubscribedReplyReason.Acknowledgment);
    expect(decision.shouldReply).toBe(false);
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("replies for assistant-directed follow-up question", async () => {
    const completeObject = vi.fn();
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
        text: "what did you just say about the budget?",
        rawText: "what did you just say about the budget?",
        conversationContext: "<thread-transcript>\n[assistant] junior: Budget is due Friday.\n</thread-transcript>"
      }),
      completeObject,
      logClassifierFailure: vi.fn()
    });

    expect(decision.reason).toBe(SubscribedReplyReason.FollowUpQuestion);
    expect(decision.shouldReply).toBe(true);
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("uses classifier and maps false decision to side conversation", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "some new text", rawText: "some new text" }),
      completeObject: vi.fn(async () => ({
        object: { should_reply: false, confidence: 0.95, reason: "status chatter" }
      })),
      logClassifierFailure: vi.fn()
    });

    expect(decision.reason).toBe(SubscribedReplyReason.SideConversation);
    expect(decision.reasonDetail).toBe("status chatter");
    expect(decision.shouldReply).toBe(false);
  });

  it("uses classifier and rejects low-confidence true", async () => {
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({ text: "some new text", rawText: "some new text" }),
      completeObject: vi.fn(async () => ({
        object: { should_reply: true, confidence: 0.6, reason: "maybe follow-up" }
      })),
      logClassifierFailure: vi.fn()
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
        object: { should_reply: true, confidence: 0.95, reason: "direct question" }
      })),
      logClassifierFailure: vi.fn()
    });

    expect(decision.reason).toBe(SubscribedReplyReason.Classifier);
    expect(decision.reasonDetail).toBe("direct question");
    expect(decision.shouldReply).toBe(true);
  });

  it("fails closed on classifier errors", async () => {
    const logClassifierFailure = vi.fn();
    const input = makeInput({ text: "some new text", rawText: "some new text" });
    const decision = await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input,
      completeObject: vi.fn(async () => {
        throw new Error("router failed");
      }),
      logClassifierFailure
    });

    expect(decision.reason).toBe(SubscribedReplyReason.ClassifierError);
    expect(decision.shouldReply).toBe(false);
    expect(logClassifierFailure).toHaveBeenCalledWith(expect.any(Error), input);
  });
});
