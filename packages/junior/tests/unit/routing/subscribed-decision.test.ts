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

type CompleteDecision = Parameters<
  typeof decideSubscribedThreadReply
>[0]["completeDecision"];

function routeAnswer(choice: string, probability: number) {
  return {
    answers: { route: { choice, probabilities: { [choice]: probability } } },
  };
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
    const completeDecision = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: "what did you just say?",
          text: "what did you just say?",
          isExplicitMention: false,
        }),
        completeDecision,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.PassiveDisabled,
      reasonDetail: "passive-routing",
    });
    expect(completeDecision).not.toHaveBeenCalled();
  });

  it("still replies to explicit mentions when passive routing is off", async () => {
    setExperimentalFeatures(undefined);
    const completeDecision = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: "please continue",
          text: "please continue",
          isExplicitMention: true,
        }),
        completeDecision,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.ExplicitMention,
    });
    expect(completeDecision).not.toHaveBeenCalled();
  });

  it.each([
    "!stop",
    "!STOP",
    "!stop don't continue with this task",
    "please leave this alone !stop",
    "ok enough for now !stop thanks",
    "<@U0APP> keep going unless I say !stop later",
  ])("unsubscribes for %s without the classifier", async (text) => {
    const completeDecision = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: text,
          text,
          isExplicitMention: text.startsWith("<@U0APP>"),
        }),
        completeDecision,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: false,
      shouldUnsubscribe: true,
      reason: SubscribedReplyReason.ThreadOptOut,
      reasonDetail: "!stop",
    });
    expect(completeDecision).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "stop after mention strip",
      rawText: "<@U0APP> stop",
      text: "stop",
    },
    {
      name: "stop with trailing punctuation",
      rawText: "@jr stop.",
      text: "stop.",
    },
    {
      name: "stop without a mention",
      rawText: "stop",
      text: "stop",
      isExplicitMention: false,
    },
  ])("unsubscribes when the whole message is $name", async (fixture) => {
    const completeDecision = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: fixture.rawText,
          text: fixture.text,
          isExplicitMention: fixture.isExplicitMention ?? true,
        }),
        completeDecision,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: false,
      shouldUnsubscribe: true,
      reason: SubscribedReplyReason.ThreadOptOut,
      reasonDetail: "stop",
    });
    expect(completeDecision).not.toHaveBeenCalled();
  });

  it.each([
    "stop the worker and restart it",
    "please stop",
    "stop — I meant staging, not prod",
    "stop spamming",
    "please continue with the PR checks",
  ])("does not treat %s as stop", async (text) => {
    const completeDecision = vi.fn();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput({
          rawText: text,
          text,
          isExplicitMention: true,
        }),
        completeDecision,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.ExplicitMention,
    });
    expect(completeDecision).not.toHaveBeenCalled();
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
      name: "a stay-quiet decision",
      choice: "stay_quiet",
      probability: 0.95,
      expected: {
        costUsd: 0.00023,
        shouldReply: false,
        reason: SubscribedReplyReason.SideConversation,
        reasonDetail: "stay_quiet p=0.95",
      },
    },
    {
      name: "a confident unsubscribe",
      choice: "unsubscribe",
      probability: 0.95,
      expected: {
        costUsd: 0.00023,
        shouldReply: false,
        shouldUnsubscribe: true,
        reason: SubscribedReplyReason.ThreadOptOut,
        reasonDetail: "unsubscribe p=0.95",
      },
    },
    {
      name: "a low-confidence reply",
      choice: "reply",
      probability: 0.65,
      expected: {
        costUsd: 0.00023,
        shouldReply: false,
        reason: SubscribedReplyReason.LowConfidence,
        reasonDetail: "reply p=0.65",
      },
    },
    {
      name: "a confident reply",
      choice: "reply",
      probability: 0.95,
      expected: {
        costUsd: 0.00023,
        shouldReply: true,
        reason: SubscribedReplyReason.Classifier,
        reasonDetail: "reply p=0.95",
      },
    },
  ])("maps $name onto the runtime decision contract", async (fixture) => {
    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input: makeInput(),
        completeDecision: vi.fn<CompleteDecision>(async () => ({
          ...routeAnswer(fixture.choice, fixture.probability),
          costUsd: 0.00023,
        })),
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual(fixture.expected);
  });

  it("projects guardian-style user/assistant evidence without tool lines", async () => {
    const completeDecision = vi.fn<CompleteDecision>(async () =>
      routeAnswer("reply", 0.72),
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
        completeDecision,
        logClassifierFailure: vi.fn(),
      }),
    ).resolves.toEqual({
      shouldReply: true,
      reason: SubscribedReplyReason.Classifier,
      reasonDetail: "reply p=0.72",
    });

    expect(completeDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "router-model",
        promptName: "junior.passive_reply_route",
        state: expect.stringContaining(">>> TRANSCRIPT START"),
      }),
    );
    const call = completeDecision.mock.calls[0]?.[0];
    expect(call?.state).toContain("user David: investigate the passive router");
    expect(call?.state).toContain(
      "assistant junior: the confidence gate looks too strict",
    );
    expect(call?.state).toContain(">>> LATEST MESSAGE START");
    expect(call?.state).not.toContain("must-not-reach-router");
    const question = call?.questions.route;
    expect(question?.type).toBe("choice");
    expect(Object.keys(question?.criteria ?? {})).toEqual([
      "reply",
      "stay_quiet",
      "unsubscribe",
    ]);
    expect(question?.instructions).toContain("Conversation Floor");
    expect(question?.instructions).toContain("untrusted evidence");
  });

  it("keeps first and recent user anchors with recent assistant evidence", async () => {
    const completeDecision = vi.fn<CompleteDecision>(async () =>
      routeAnswer("stay_quiet", 0.9),
    );
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
      completeDecision,
      logClassifierFailure: vi.fn(),
    });

    const state = completeDecision.mock.calls[0]?.[0].state;
    expect(state).toBeDefined();
    expect(state).toContain("user David: original request");
    expect(state).toContain("assistant junior: latest answer");
    expect(state).toContain("user David: latest request");
    expect(state).toContain("Omitted earlier transcript entries:");
    expect(state).not.toContain("user Person 0:");
  });

  it("fails closed when the decision model returns an unknown route", async () => {
    const logClassifierFailure = vi.fn();
    const input = makeInput();

    await expect(
      decideSubscribedThreadReply({
        botUserName: "junior",
        modelId: "router-model",
        input,
        completeDecision: vi.fn<CompleteDecision>(async () =>
          routeAnswer("maybe", 1),
        ),
        logClassifierFailure,
      }),
    ).resolves.toEqual({
      shouldReply: false,
      reason: SubscribedReplyReason.ClassifierError,
    });
    expect(logClassifierFailure).toHaveBeenCalledWith(expect.any(Error), input);
  });
});
