import { afterEach, describe, expect, it, vi } from "vitest";
import { setExperimentalFeatures } from "@/chat/experimental";
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
    completeObject: vi.fn(async () => ({ costUsd: 0.00023, object })),
    logClassifierFailure: vi.fn(),
  });
}

describe("subscribed reply decision", () => {
  afterEach(() => {
    setExperimentalFeatures({
      "passive-routing": true,
      subagents: true,
    });
  });

  it("skips non-mention replies when passive-routing is off", async () => {
    setExperimentalFeatures(undefined);
    const completeObject = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: "what did you just say?",
          text: "what did you just say?",
          isExplicitMention: false,
        }),
        completeObject,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.PassiveDisabled,
      reasonDetail: "passive-routing",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("still replies to explicit mentions when passive routing is off", async () => {
    setExperimentalFeatures(undefined);
    const completeObject = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: "please continue",
          text: "please continue",
          isExplicitMention: true,
        }),
        completeObject,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.ExplicitMention,
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

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
      name: "bare stop after mention strip",
      rawText: "<@U0APP> stop",
      text: "stop",
    },
    {
      name: "bare stop with trailing punctuation",
      rawText: "@jr stop.",
      text: "stop.",
    },
    {
      name: "please stop",
      rawText: "@jr please stop",
      text: "please stop",
    },
    {
      name: "stop with redirect after em dash",
      rawText: "@jr stop — I meant staging, not prod",
      text: "stop — I meant staging, not prod",
    },
    {
      name: "stop spamming",
      rawText: "@jr stop spamming",
      text: "stop spamming",
    },
    {
      name: "can you stop",
      rawText: "@jr can you stop",
      text: "can you stop",
    },
    {
      name: "stop it",
      rawText: "stop it",
      text: "stop it",
    },
  ])(
    "unsubscribes explicit mentions for $name without calling the classifier",
    async (fixture) => {
      const completeObject = vi.fn();

      await expect(
        decideSubscribedThreadReply({
          botUserName: "junior",
          modelId: "router-model",
          input: makeInput({
            rawText: fixture.rawText,
            text: fixture.text,
            isExplicitMention: true,
          }),
          completeObject,
          logClassifierFailure: vi.fn(),
        }),
      ).resolves.toEqual({
        shouldReply: false,
        shouldUnsubscribe: true,
        reason: SubscribedReplyReason.ThreadOptOut,
        reasonDetail: "explicit stop instruction",
      });
      expect(completeObject).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "stop as a task verb",
      text: "stop the worker and restart it",
    },
    {
      name: "how to stop something",
      text: "how do I stop the sandbox keepalive?",
    },
    {
      name: "can you stop a concrete task",
      text: "can you stop the worker and restart it",
    },
    {
      name: "non-stop continuation",
      text: "please continue with the PR checks",
    },
  ])(
    "does not treat $name as an explicit-mention opt-out",
    async (fixture) => {
      const completeObject = vi.fn();

      await expect(
        decideSubscribedThreadReply({
          botUserName: "junior",
          modelId: "router-model",
          input: makeInput({
            rawText: fixture.text,
            text: fixture.text,
            isExplicitMention: true,
          }),
          completeObject,
          logClassifierFailure: vi.fn(),
        }),
      ).resolves.toEqual({
        shouldReply: true,
        reason: SubscribedReplyReason.ExplicitMention,
      });
      expect(completeObject).not.toHaveBeenCalled();
    },
  );

  it("unsubscribes bare stop in a subscribed thread without a mention", async () => {
    const completeObject = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: "stop",
          text: "stop",
          isExplicitMention: false,
        }),
        completeObject,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: false,
      shouldUnsubscribe: true,
      reason: SubscribedReplyReason.ThreadOptOut,
      reasonDetail: "stop instruction",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

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
        costUsd: 0.00023,
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
        costUsd: 0.00023,
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
        confidence: 0.65,
        reason: "maybe follow-up",
      },
      expected: {
        costUsd: 0.00023,
        shouldReply: false,
        reason: SubscribedReplyReason.LowConfidence,
        reasonDetail: "0.65: maybe follow-up",
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
        costUsd: 0.00023,
        shouldReply: true,
        reason: SubscribedReplyReason.Classifier,
        reasonDetail: "direct question",
      },
    },
  ])("maps $name onto the runtime decision contract", async (fixture) => {
    await expect(classify(fixture.object)).resolves.toEqual(fixture.expected);
  });

  it("projects guardian-style user/assistant evidence without tool lines", async () => {
    const completeObject = vi.fn(
      async (_request: { prompt: string; system: string }) => ({
        object: {
          should_reply: true,
          should_unsubscribe: false,
          confidence: 0.72,
          reason: "natural continuation",
        },
      }),
    );

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: "can you check on this?",
          text: "can you check on this?",
          conversationContext: [
            '<thread-context authority="evidence-only">',
            '  <message role="user" author="David">',
            "[user] David: investigate the passive router",
            "  </message>",
            '  <message role="assistant" author="junior">',
            "[assistant] junior: the confidence gate looks too strict",
            "  </message>",
            "[tool] grep result: must-not-reach-router",
            "</thread-context>",
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
        promptName: "junior.passive_reply_route",
        prompt: expect.stringContaining(">>> TRANSCRIPT START"),
        system: expect.stringContaining("# Evidence Handling"),
      }),
    );
    const call = completeObject.mock.calls[0]?.[0];
    expect(call?.prompt).toContain(
      "user David: investigate the passive router",
    );
    expect(call?.prompt).toContain(
      "assistant junior: the confidence gate looks too strict",
    );
    expect(call?.prompt).toContain(">>> LATEST MESSAGE START");
    expect(call?.prompt).not.toContain("must-not-reach-router");
    expect(call?.system).toContain("Conversation Floor");
    expect(call?.system).toContain("untrusted evidence");
  });

  it("keeps first and recent user anchors with recent assistant evidence", async () => {
    const completeObject = vi.fn(async (_request: { prompt: string }) => ({
      object: {
        should_reply: false,
        should_unsubscribe: false,
        confidence: 0.9,
        reason: "human side conversation",
      },
    }));
    const middle = Array.from({ length: 12 }, (_, index) => {
      const filler = "x".repeat(8_000);
      return `[user] Person ${index}: ${index}-${filler}`;
    });

    await decideSubscribedThreadReply({
      botUserName: "junior",
      modelId: "router-model",
      input: makeInput({
        conversationContext: [
          "[user] David: original request",
          ...middle,
          "[assistant] junior: latest answer",
          "[user] David: latest request",
        ].join("\n"),
      }),
      completeObject,
      logClassifierFailure: vi.fn(),
    });

    const prompt = completeObject.mock.calls[0]?.[0].prompt;
    expect(prompt).toBeDefined();
    expect(prompt).toContain("user David: original request");
    expect(prompt).toContain("assistant junior: latest answer");
    expect(prompt).toContain("user David: latest request");
    expect(prompt).toContain("Omitted earlier transcript entries:");
    expect(prompt).not.toContain("user Person 0:");
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
