import { describe, expect, it } from "vitest";
import { describedProposal } from "@/chat/guardian/proposal-tool";

describe("describedProposal", () => {
  it("gives the current Guardian only the summary of the tool's guardian", () => {
    expect(
      describedProposal({
        summary: "Unpublish image abc.png.",
        target: { ref: "abc.png", audience: "world" },
      }),
    ).toBe("Unpublish image abc.png.");
    expect(
      describedProposal({
        target: { ref: "getsentry/junior#12", audience: "world" },
        toolDecision: { decision: "allow", reason: "own-pr-text" },
      }),
    ).toBeUndefined();
  });
});
