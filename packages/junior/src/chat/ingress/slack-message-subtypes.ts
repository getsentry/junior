import type { SlackInboundEvent } from "./slack-payload";

const IGNORED_MESSAGE_SUBTYPES = new Set([
  // An edit is not new input. `handleSlackMessageEdit` applies it without
  // starting a Turn.
  "message_changed",
  "message_deleted",
  "message_replied",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "ekm_access_denied",
  "tombstone",
]);

/** Whether ingress ignores a Slack message event for its subtype. */
export function shouldIgnoreMessageSubtype(event: SlackInboundEvent): boolean {
  return Boolean(event.subtype && IGNORED_MESSAGE_SUBTYPES.has(event.subtype));
}
