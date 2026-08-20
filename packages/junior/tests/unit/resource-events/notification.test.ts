import { describe, expect, it } from "vitest";
import { renderResourceEventNotificationText } from "@/chat/resource-events/notification";
import {
  isResourceEventSlackMessage,
  replyAttributionForResourceEventMessages,
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

    expect(text).toContain("[automated update]");
    expect(text).toContain("came from a watch, not a person");
    expect(text).toContain("do not reply");
    expect(text).toContain("GitHub PR getsentry/junior#691");
    expect(text).toContain("pull_request.checks.failed");
    expect(text).toContain("Fix failed checks on this PR.");
    expect(text).toContain("CI failed on workflow test.");
    expect(text).toContain('"pullRequest": 691');
    expect(text).toContain("External text");
    expect(text).toContain("Failed checks:");
    expect(text).not.toContain("subscription intent");
    expect(text).not.toContain("provider content");
    expect(text).not.toContain("system ids");
  });

  it("uses the verified summary for one Slack update", () => {
    const message = {
      id: "event-1",
      raw: {
        event_type: "resource_event",
        resource_event_label: "GitHub PR getsentry/junior#1637",
        resource_event_summary:
          "GitHub PR getsentry/junior#1637 received a review comment.",
      },
    };

    expect(isResourceEventSlackMessage(message)).toBe(true);
    expect(replyAttributionForResourceEventMessages([message])).toEqual({
      label: "Update",
      detail:
        "GitHub PR getsentry/junior#1637 received a review comment.",
    });
  });

  it("summarizes every Slack update that contributed to the turn", () => {
    expect(
      replyAttributionForResourceEventMessages([
        {
          id: "event-1",
          raw: {
            event_type: "resource_event",
            resource_event_summary: "Checks failed.",
          },
        },
        { id: "human-message", raw: {} },
        {
          id: "event-2",
          raw: {
            event_type: "resource_event",
            resource_event_summary: "A review comment was added.",
          },
        },
        {
          id: "event-3",
          raw: {
            event_type: "resource_event",
            resource_event_summary: "The pull request was approved.",
          },
        },
      ]),
    ).toEqual({
      label: "3 updates",
      detail: "The pull request was approved. (+2 more)",
    });
  });
});
