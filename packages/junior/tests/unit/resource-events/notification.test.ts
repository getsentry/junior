import { describe, expect, it } from "vitest";
import { renderResourceEventNotificationText } from "@/chat/resource-events/notification";

describe("resource event notification framing", () => {
  it("passes subscription facts into shared task framing", () => {
    const text = renderResourceEventNotificationText(
      {
        intent: "Fix failed checks on this PR.",
        label: "GitHub PR getsentry/junior#691",
        resourceType: "pull_request",
      },
      {
        namespace: "github",
        eventType: "pull_request.checks.failed",
        trustedSummary: "CI failed on workflow test.",
        data: { pullRequest: 691 },
        untrustedText: "Failed checks:\n- test",
      },
    );

    expect(text).toContain("[task]");
    expect(text).toContain("Source: resource subscription");
    expect(text).toContain("About: GitHub PR getsentry/junior#691");
    expect(text).toContain("Instructions: Fix failed checks on this PR.");
    expect(text).toContain("What changed: CI failed on workflow test.");
    expect(text).toContain('"pullRequest": 691');
    expect(text).toContain("Failed checks:\n- test");
  });
});
