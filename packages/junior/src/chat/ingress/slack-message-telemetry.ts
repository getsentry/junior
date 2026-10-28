import type { SlackEventEnvelope } from "./slack-payload";

// Keep absent and malformed fields distinct without recording arbitrary input.
function field(value: unknown, pattern: RegExp): string {
  if (value === undefined) return "missing";
  return typeof value === "string" && value.length <= 64 && pattern.test(value)
    ? value
    : "invalid";
}

/** Record Slack's identity fields separately from the membership decision. */
export function slackMessageAttributes(body: SlackEventEnvelope) {
  const event = body.event;
  const teamId = /^[TE][A-Z0-9]+$/;
  return {
    "messaging.message.id": event?.ts,
    "app.slack.event_id": field(body.event_id, /^Ev[A-Z0-9]+$/),
    "app.slack.event_type": field(event?.type, /^[a-z_]+$/),
    "app.slack.event_subtype": field(event?.subtype, /^[a-z_]+$/),
    "app.slack.user_id": field(event?.user, /^[UW][A-Z0-9]+$/),
    "app.slack.bot_id": field(event?.bot_id, /^B[A-Z0-9]+$/),
    "app.slack.team_id": field(body.team_id, /^T[A-Z0-9]+$/),
    "app.slack.enterprise_id": field(body.enterprise_id, /^E[A-Z0-9]+$/),
    "app.slack.user_team": field(event?.user_team, teamId),
    "app.slack.source_team": field(event?.source_team, teamId),
    "app.slack.event_team": field(event?.team, teamId),
    "app.slack.is_ext_shared_channel":
      typeof body.is_ext_shared_channel === "boolean"
        ? body.is_ext_shared_channel
        : body.is_ext_shared_channel === undefined
          ? "missing"
          : "invalid",
  };
}
