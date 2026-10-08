import { describe, expect, it } from "vitest";
import { bindTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import {
  createEventInboundMessage,
  renderEventNotificationText,
  timerWatchCredentialSubject,
} from "@/chat/events/notification";

describe("event notification framing", () => {
  it("passes subscription facts into shared task framing", () => {
    const text = renderEventNotificationText(
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
    expect(text).toContain("About: GitHub PR getsentry/junior#691");
    expect(text).toContain("Instructions: Fix failed checks on this PR.");
    expect(text).toContain("Trusted summary: CI failed on workflow test.");
    expect(text).toContain('"pullRequest": 691');
    expect(text).toContain("Failed checks:\n- test");
  });
});

describe("timer Watch credential subject", () => {
  const conversationId = "conversation-1";
  const timerMessage = (watchId: string, userId: string, boundTo = watchId) =>
    createEventInboundMessage({
      event: {
        eventKey: `timer:${watchId}`,
        eventType: "timer.fired",
        identifier: watchId,
        namespace: "junior",
        occurredAtMs: 1,
        trustedSummary: "Timer fired.",
      },
      subscription: {
        conversationId,
        credentialSubject: bindTimerWatchCredentialSubject({
          conversationId,
          userId,
          watchId: boundTo,
        }),
        id: watchId,
      },
      text: "Timer fired.",
    });

  it("uses the subject only when every event binds the same user to its own Watch", () => {
    expect(
      timerWatchCredentialSubject(conversationId, [
        timerMessage("timer-1", "U123"),
        timerMessage("timer-2", "U123"),
      ]),
    ).toMatchObject({ userId: "U123", allowedWhen: "timer-watch" });
    // A subject signed for another Watch does not transfer.
    expect(
      timerWatchCredentialSubject(conversationId, [
        timerMessage("timer-2", "U123", "timer-1"),
      ]),
    ).toBeUndefined();
    expect(
      timerWatchCredentialSubject(conversationId, [
        timerMessage("timer-1", "U123"),
        timerMessage("timer-2", "U456"),
      ]),
    ).toBeUndefined();
    expect(
      timerWatchCredentialSubject("conversation-2", [
        timerMessage("timer-1", "U123"),
      ]),
    ).toBeUndefined();
  });
});
