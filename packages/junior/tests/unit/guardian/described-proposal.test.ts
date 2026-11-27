import { describe, expect, it } from "vitest";
import { describedProposal } from "@/chat/guardian/gate";

describe("describedProposal", () => {
  it("uses the summary when the tool's guardian gives one", () => {
    expect(
      describedProposal({
        summary: "Unpublish image abc.png.",
        target: { ref: "abc.png", audience: "world" },
      }),
    ).toBe("Unpublish image abc.png.");
  });

  it("falls back to the target with its reason label", () => {
    expect(
      describedProposal({
        target: { ref: "getsentry/junior#12", audience: "world" },
        toolDecision: { decision: "allow", reason: "own-pr-text" },
      }),
    ).toBe("getsentry/junior#12 (own-pr-text)");
    expect(
      describedProposal({ target: { ref: "PY-12", audience: "world" } }),
    ).toBe("PY-12");
  });

  it("gives no line for a call without a target", () => {
    expect(describedProposal({})).toBeUndefined();
    expect(describedProposal(undefined)).toBeUndefined();
  });
});
