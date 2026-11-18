import { describe, expect, it } from "vitest";

import { viewerAnswerLine } from "../src/client/review-desk/reviewItemFormat";

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
