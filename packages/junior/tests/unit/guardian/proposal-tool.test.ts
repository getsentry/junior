import { describe, expect, it } from "vitest";
import { describedProposal } from "@/chat/guardian/proposal-tool";

describe("describedProposal", () => {
  it("uses the summary when the tool's guardian gives one", () => {
    expect(
      describedProposal(
        {
          summary: "Unpublish image abc.png.",
          target: { ref: "abc.png", audience: "world" },
        },
        "unpublishImage",
        { ref: "abc.png" },
      ),
    ).toBe("Unpublish image abc.png.");
  });

  it("falls back to the target with its reason label", () => {
    expect(
      describedProposal(
        {
          target: { ref: "getsentry/junior#12", audience: "world" },
          toolDecision: { decision: "allow", reason: "own-pr-text" },
        },
        "github_updatePullRequest",
        { body: "New body" },
      ),
    ).toBe("getsentry/junior#12 (own-pr-text)");
    expect(
      describedProposal(
        { target: { ref: "PY-12", audience: "world" } },
        "linear_updateIssue",
        {},
      ),
    ).toBe("PY-12");
  });

  it("falls back to the tool name and a bounded input without a target", () => {
    expect(
      describedProposal(undefined, "createAutomation", { cron: "0 9 * * 1" }),
    ).toBe('createAutomation {"cron":"0 9 * * 1"}');
    const long = describedProposal({}, "createAutomation", {
      task: "x".repeat(1_000),
    });
    expect(long.length).toBeLessThanOrEqual(320);
    expect(long).toContain("[truncated]");
  });
});
