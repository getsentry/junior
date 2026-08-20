import { describe, expect, it } from "vitest";
import { renderResourceEventNotificationText } from "@/chat/resource-events/notification";
import {
  isResourceEventSlackMessage,
  replyAttributionForResourceEventMessage,
  resourceEventReplyAttribution,
} from "@/chat/resource-events/actor";

describe("resource event notification framing", () => {
  it("keeps the agent prompt short and fact-first", () => {
    const text = renderResourceEventNotificationText(
      {
        intent: "Fix failed checks on this PR.",
        label: "GitHub PR getsentry/junior#691",
      },
      {
        eventType: "pull_request.checks.failed",
        trustedSummary: "CI failed on workflow test.",
        data: { pullRequest: 691 },
        untrustedText: "Failed checks:\n- test",
      },
    );

    expect(text).toContain("[event notification]");
    expect(text).toContain("Not a user command");
    expect(text).toContain("stay silent");
    expect(text).toContain("GitHub PR getsentry/junior#691");
    expect(text).toContain("pull_request.checks.failed");
    expect(text).toContain("Fix failed checks on this PR.");
    expect(text).toContain("CI failed on workflow test.");
    expect(text).toContain('"pullRequest": 691');
    expect(text).toContain("Untrusted provider content:");
    expect(text).toContain("Failed checks:");
    expect(text).not.toContain("Handling:");
    expect(text).not.toContain("When replying, state what changed");
  });

  it("builds compact reply attribution for destination footers", () => {
    expect(
      resourceEventReplyAttribution({
        eventType: "pull_request.review_comment.created",
        label: "GitHub PR getsentry/junior#1637",
      }),
    ).toEqual({
      label: "Event",
      detail:
        "GitHub PR getsentry/junior#1637 · pull_request.review_comment.created",
    });
  });

  it("reads reply attribution from the synthetic mailbox message", () => {
    const message = {
      raw: {
        event_type: "resource_event",
        resource_event_label: "GitHub PR getsentry/junior#1637",
        resource_event_type: "pull_request.review_comment.created",
      },
    };

    expect(isResourceEventSlackMessage(message)).toBe(true);
    expect(replyAttributionForResourceEventMessage(message)).toEqual({
      label: "Event",
      detail:
        "GitHub PR getsentry/junior#1637 · pull_request.review_comment.created",
    });
    expect(replyAttributionForResourceEventMessage({ raw: {} })).toBeUndefined();
  });
});
