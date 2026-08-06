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
    sourceText: "hello",
    text: "hello",
    hasAttachments: false,
    isExplicitMention: false,
    context: {},
    ...overrides,
  };
}

function classify(
  object: {
    should_reply: boolean;
    should_unsubscribe: boolean;
    confidence: number;
    reason: string;
  },
  input = makeInput(),
) {
  return decideSubscribedThreadReply({
    botUserName: "junior",
    modelId: "router-model",
    input,
    completeObject: vi.fn(async () => ({ object })),
    logClassifierFailure: vi.fn(),
  });
}

describe("subscribed reply decision", () => {
  it.each(["!stop", "!STOP", "!stop don't continue with this task"])(
    "forces unsubscribe for %s without calling the classifier",
    async (text) => {
      const completeObject = vi.fn();

      await expect(
        decideSubscribedThreadReply({
          botUserName: "junior",
          modelId: "router-model",
          input: makeInput({ sourceText: text, text }),
          completeObject,
          logClassifierFailure: vi.fn(),
        }),
      ).resolves.toEqual({
        shouldReply: false,
        shouldUnsubscribe: true,
        reason: SubscribedReplyReason.ThreadOptOut,
        reasonDetail: "forced !stop command",
      });
      expect(completeObject).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "a leading named mention",
      sourceText: "@Cursor can you take this one?",
      text: "@Cursor can you take this one?",
      expected: "named_mention:Cursor",
    },
    {
      name: "a leading Slack mention",
      sourceText: "<@UCURSOR> can you take this one?",
      text: "<@UCURSOR> can you take this one?",
      expected: "slack_mention",
    },
  ])("preflight-skips $name addressed to another party", (fixture) => {
    expect(
      getSubscribedReplyPreflightDecision({
        botUserName: "junior",
        sourceText: fixture.sourceText,
        text: fixture.text,
        isExplicitMention: false,
      }),
    ).toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.DirectedToOtherParty,
      reasonDetail: fixture.expected,
    });
  });

  it.each([
    "@Cursor and @junior can one of you take this?",
    "please ask @Cursor to look at this later",
  ])("does not preflight-skip %s", (text) => {
    expect(
      getSubscribedReplyPreflightDecision({
        botUserName: "junior",
        sourceText: text,
        text,
        isExplicitMention: false,
      }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "a negative decision",
      object: {
        should_reply: false,
        should_unsubscribe: false,
        confidence: 0.95,
        reason: "status chatter",
      },
      expected: {
        shouldReply: false,
        reason: SubscribedReplyReason.SideConversation,
        reasonDetail: "status chatter",
      },
    },
    {
      name: "a confident unsubscribe",
      object: {
        should_reply: false,
        should_unsubscribe: true,
        confidence: 0.95,
        reason: "stop participating",
      },
      expected: {
        shouldReply: false,
        shouldUnsubscribe: true,
        reason: SubscribedReplyReason.ThreadOptOut,
        reasonDetail: "stop participating",
      },
    },
    {
      name: "a low-confidence reply",
      object: {
        should_reply: true,
        should_unsubscribe: false,
        confidence: 0.75,
        reason: "maybe follow-up",
      },
      expected: {
        shouldReply: false,
        reason: SubscribedReplyReason.LowConfidence,
        reasonDetail: "0.75: maybe follow-up",
      },
    },
    {
      name: "a confident reply",
      object: {
        should_reply: true,
        should_unsubscribe: false,
        confidence: 0.95,
        reason: "direct question",
      },
      expected: {
        shouldReply: true,
        reason: SubscribedReplyReason.Classifier,
        reasonDetail: "direct question",
      },
    },
  ])("maps $name onto the runtime decision contract", async (fixture) => {
    await expect(classify(fixture.object)).resolves.toEqual(fixture.expected);
  });

  it("fails closed when the classifier result is invalid", async () => {
    const logClassifierFailure = vi.fn();
    const input = makeInput();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input,
        completeObject: vi.fn(async () => ({
          object: { should_reply: "yes" },
        })),
        logClassifierFailure,
      }),
    ).resolves.toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.ClassifierError,
    });
    expect(logClassifierFailure).toHaveBeenCalledWith(expect.any(Error), input);
  });
});
