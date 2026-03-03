import type { SlackEventsApiEnvelope } from "../../fixtures/slack/factories/events";

// Reusable placeholder for route tests that assert inbound Slack webhook payloads.
// No default webhook interception is registered yet.
export const slackWebhookHandlers = [];

export function isSlackEventsApiEnvelope(value: unknown): value is SlackEventsApiEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SlackEventsApiEnvelope>;
  return candidate.type === "event_callback" && typeof candidate.event === "object";
}
