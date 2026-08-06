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
          input: makeInput({ rawText: text, text }),
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
      rawText: "@Cursor can you take this one?",
      text: "@Cursor can you take this one?",
      expected: "named_mention:Cursor",
    },
    {
      name: "a leading Slack mention",
      rawText: "<@UCURSOR> can you take this one?",
      text: "<@UCURSOR> can you take this one?",
      expected: "slack_mention",
    },
  ])("preflight-skips $name addressed to another party", (fixture) => {
    expect(
      getSubscribedReplyPreflightDecision({
        botUserName: "junior",
        rawText: fixture.rawText,
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
        rawText: text,
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

  it("projects bounded user and assistant context without tool evidence", async () => {
    const completeObject = vi.fn(async (_request: { prompt: string }) => ({
      object: {
        should_reply: true,
        should_unsubscribe: false,
        confidence: 0.72,
        reason: "natural continuation",
      },
    }));

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: "can you check on this?",
          text: "can you check on this?",
          conversationContext: [
            "<thread-transcript>",
            '  <message role="user" author="David">',
            "[user] David: investigate the passive router",
            "  </message>",
            '  <message role="assistant" author="junior">',
            "[assistant] junior: the confidence gate looks too strict",
            "  </message>",
            "[tool] grep result: must-not-reach-router",
            "</thread-transcript>",
          ].join("\n"),
        }),
        completeObject,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.Classifier,
      reasonDetail: "natural continuation",
    });

    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 400,
        prompt: expect.stringContaining(
          "[assistant] junior: the confidence gate looks too strict",
        ),
        system: expect.stringContaining(
          "naturally continues work it was doing",
        ),
      }),
    );
    const prompt = completeObject.mock.calls[0]?.[0].prompt;
    expect(prompt).toBeDefined();
    expect(prompt).toContain("[user] David: investigate the passive router");
    expect(prompt).not.toContain("must-not-reach-router");
  });

  it("keeps the first user message with the recent user and assistant exchange", async () => {
    const completeObject = vi.fn(async (_request: { prompt: string }) => ({
      object: {
        should_reply: false,
        should_unsubscribe: false,
        confidence: 0.9,
        reason: "human side conversation",
      },
    }));
    const middle = Array.from(
      { length: 45 },
      (_, index) => `[user] Person ${index}: message ${index}`,
    );

    await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
        conversationContext: [
          "[user] David: original request",
          ...middle,
          "[assistant] junior: latest answer",
        ].join("\n"),
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    const prompt = completeObject.mock.calls[0]?.[0].prompt;
    expect(prompt).toBeDefined();
    expect(prompt).toContain("[user] David: original request");
    expect(prompt).toContain("[assistant] junior: latest answer");
    expect(prompt).not.toContain("[user] Person 0: message 0");
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
