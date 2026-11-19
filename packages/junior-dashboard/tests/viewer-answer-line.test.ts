import { describe, expect, it } from "vitest";

import { conversationAnswerLine } from "../src/client/review-desk/reviewItemFormat";

describe("conversationAnswerLine", () => {
  const closedAt = "2026-08-05T16:00:00.000Z";
  const viewerAnswer = { choices: ["Hold"], closedAt };

  it("keeps the answer when its own Message has the close time", () => {
    expect(
      conversationAnswerLine({ lastMessageAt: closedAt, viewerAnswer }),
    ).toBe("You answered Hold");
  });

  it("drops the answer once a later Message moves the Conversation on", () => {
    expect(
      conversationAnswerLine({
        lastMessageAt: "2026-08-05T16:00:01.000Z",
        viewerAnswer,
      }),
    ).toBeUndefined();
  });

  it("says You replied for an answer with only text", () => {
    expect(
      conversationAnswerLine({ viewerAnswer: { choices: [], closedAt } }),
    ).toBe("You replied");
  });
});
