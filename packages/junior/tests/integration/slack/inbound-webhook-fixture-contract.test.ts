import { describe, expect, it } from "vitest";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { isSlackEventsApiEnvelope } from "../../msw/handlers/slack-webhooks";

describe("Slack fixtures: inbound webhook envelopes", () => {
  it("builds a valid event_callback envelope for app mentions", () => {
    const payload = slackEventsApiEnvelope({
      eventType: "app_mention",
      channel: "C12345",
      ts: "1700000000.500"
    });

    expect(isSlackEventsApiEnvelope(payload)).toBe(true);
    expect(payload.event).toMatchObject({
      type: "app_mention",
      channel: "C12345",
      ts: "1700000000.500",
      event_ts: "1700000000.500",
      channel_type: "channel"
    });
  });

  it("marks DM message events as channel_type=im and preserves thread_ts", () => {
    const payload = slackEventsApiEnvelope({
      eventType: "message",
      channel: "D12345",
      ts: "1700000000.700",
      threadTs: "1700000000.100"
    });

    expect(isSlackEventsApiEnvelope(payload)).toBe(true);
    expect(payload.event).toMatchObject({
      type: "message",
      channel_type: "im",
      ts: "1700000000.700",
      thread_ts: "1700000000.100"
    });
  });

  it("rejects malformed payloads that miss required Slack event fields", () => {
    const payload = slackEventsApiEnvelope();
    const malformed = {
      ...payload,
      event: {
        ...payload.event,
        event_ts: undefined
      }
    };

    expect(isSlackEventsApiEnvelope(malformed)).toBe(false);
  });
});
