import { describe, expect, it, vi } from "vitest";
import { createJevSubscribedReplyClassifier } from "@/chat/services/jev-subscribed-reply-classifier";
import type { RouterEvidence } from "@/chat/services/subscribed-decision";

const evidence: RouterEvidence = {
  assistantWasLastSpeaker: true,
  currentMessageHasAttachments: false,
  currentMessageHasDirectedFollowUpCue: false,
  currentMessageIsTerseClarification: false,
  entries: [{ author: "junior", role: "assistant", text: "I opened the PR." }],
  humanMessagesSinceLastAssistant: 0,
  latestPriorAssistantMessage: "I opened the PR.",
  latestPriorMessageRole: "assistant",
  omittedEntries: 0,
};

describe("JEV subscribed reply classifier", () => {
  it("maps calibrated probabilities to a reply decision", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          model: "jev-latest",
          answers: {
            should_reply: { type: "noul", noul: 0.91 },
            should_unsubscribe: { type: "noul", noul: 0.03 },
          },
          usage: { input_tokens: 120, output_tokens: 2 },
        }),
    );
    const classify = createJevSubscribedReplyClassifier({
      apiKey: "test-key",
      fetch: fetchMock,
    });

    await expect(
      classify({
        botUserName: "junior",
        evidence,
        latestMessage: "can you link it?",
      }),
    ).resolves.toEqual({
      confidence: 0.91,
      reason: "jev reply=0.91 unsubscribe=0.03",
      shouldReply: true,
      shouldUnsubscribe: false,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({
      authorization: "Bearer test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "jev-latest",
      state: {
        assistant_name: "junior",
        latest_message: "can you link it?",
      },
      questions: {
        should_reply: { type: "noul" },
        should_unsubscribe: { type: "noul" },
      },
    });
  });

  it("fails when TypeSafe returns a provider error", async () => {
    const classify = createJevSubscribedReplyClassifier({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response("overloaded", { status: 529 })),
    });

    await expect(
      classify({
        botUserName: "junior",
        evidence,
        latestMessage: "please continue",
      }),
    ).rejects.toThrow("TypeSafe System One request failed (529)");
  });
});
