import type { SlackEventsApiEnvelope } from "../../fixtures/slack/factories/events";

// Reusable placeholder for route tests that assert inbound Slack webhook payloads.
// No default webhook interception is registered yet.
export const slackWebhookHandlers = [];

export function isSlackEventsApiEnvelope(value: unknown): value is SlackEventsApiEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SlackEventsApiEnvelope>;
  if (
    candidate.type !== "event_callback" ||
    typeof candidate.token !== "string" ||
    typeof candidate.team_id !== "string" ||
    typeof candidate.api_app_id !== "string" ||
    typeof candidate.event_id !== "string" ||
    typeof candidate.event_time !== "number" ||
    !candidate.event ||
    typeof candidate.event !== "object"
  ) {
    return false;
  }

  const event = candidate.event as Partial<SlackEventsApiEnvelope["event"]>;
  return (
    (event.type === "app_mention" || event.type === "message") &&
    typeof event.user === "string" &&
    typeof event.text === "string" &&
    typeof event.channel === "string" &&
    typeof event.ts === "string" &&
    typeof event.event_ts === "string"
  );
}
