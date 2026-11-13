import { extractAttachmentFiles } from "@/chat/slack/message/attachments";
import type { SlackEventEnvelope } from "./slack-payload";

// Keep absent and malformed fields distinct without recording arbitrary input.
function field(value: unknown, pattern: RegExp): string {
  if (value === undefined) return "missing";
  return typeof value === "string" && value.length <= 64 && pattern.test(value)
    ? value
    : "invalid";
}

// Ingress drops `message_changed`. Record which message changed and how many
// files it has, so a trace shows when Slack attached files late.
function editedMessageAttributes(event: unknown) {
  const { subtype, message } = (event ?? {}) as {
    message?: { attachments?: unknown; files?: unknown; ts?: unknown };
    subtype?: unknown;
  };
  if (subtype !== "message_changed" || !message) return {};
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  return {
    "app.slack.edited_message.ts": field(message.ts, /^\d+\.\d+$/),
    "app.slack.edited_message.file_count":
      fileCount + extractAttachmentFiles(message.attachments).length,
  };
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
    "app.slack.context_team_id": field(body.context_team_id, /^T[A-Z0-9]+$/),
    "app.slack.context_enterprise_id":
      body.context_enterprise_id === null
        ? "none"
        : field(body.context_enterprise_id, /^E[A-Z0-9]+$/),
    "app.slack.is_ext_shared_channel":
      typeof body.is_ext_shared_channel === "boolean"
        ? body.is_ext_shared_channel
        : body.is_ext_shared_channel === undefined
          ? "missing"
          : "invalid",
    ...editedMessageAttributes(event),
  };
}
