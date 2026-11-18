import { describe, expect, it } from "vitest";

import {
  conversationAnswerLine,
  viewerAnswerLine,
} from "../src/client/review-desk/reviewItemFormat";

const request = {
  question: "Roll out payments-v42?",
  fields: [
    {
      id: "go",
      kind: "choice" as const,
      label: "Rollout",
      options: [{ label: "Roll out" }, { label: "Hold" }],
    },
    { id: "reason", kind: "text" as const, label: "Reason" },
  ],
};

describe("viewerAnswerLine", () => {
  it("names the picked choice, not the typed text", () => {
    expect(
      viewerAnswerLine({
        answer: {
          requestId: "r",
          values: { go: ["Hold"], reason: ["EU is out."] },
        },
        request,
      }),
    ).toBe("You answered Hold");
  });

  it("says You replied for an answer with only text", () => {
    expect(
      viewerAnswerLine({
        answer: { other: "Wait for Monday.", requestId: "r", values: {} },
        request,
      }),
    ).toBe("You replied");
  });

  it("says nothing without an answer", () => {
    expect(viewerAnswerLine({ request })).toBeUndefined();
  });
});

describe("conversationAnswerLine", () => {
  const closedAt = "2026-08-05T16:00:00.000Z";
  const answered = {
    addedByConversationId: "c1",
    answer: { requestId: "r", values: { go: ["Hold"] } },
    closedAt,
    closedBy: { email: "me@example.com", userId: "u-me" },
    request,
  };
  const later = (fields: Partial<typeof answered>) => ({
    ...answered,
    answer: undefined,
    closedAt: "2026-08-05T17:00:00.000Z",
    ...fields,
  });

  it("keeps the answer when its own Message has the close time", () => {
    expect(
      conversationAnswerLine(
        [answered],
        { id: "c1", lastMessageAt: closedAt },
        "me@example.com",
      ),
    ).toBe("You answered Hold");
  });

  it("drops the answer once a later Message moves the Conversation on", () => {
    expect(
      conversationAnswerLine(
        [answered],
        { id: "c1", lastMessageAt: "2026-08-05T16:00:01.000Z" },
        "me@example.com",
      ),
    ).toBeUndefined();
  });

  it("finds the viewer's answer past a later close by someone else", () => {
    const other = later({
      closedBy: { email: "them@example.com", userId: "u-them" },
    });
    expect(
      conversationAnswerLine(
        [other, answered],
        { id: "c1", lastMessageAt: closedAt },
        "me@example.com",
      ),
    ).toBe("You answered Hold");
  });
});
