/**
 * Slack channel-message Events for Event automations.
 *
 * Core publishes these Events from Slack ingress, so the `slack` namespace is
 * core owned, like `junior`. Anyone in the channel writes the Event text, so an
 * automation can watch only its own channel and always uses system credentials.
 */
import type {
  Event,
  EventInput,
  PluginEvents,
} from "@sentry/junior-plugin-api";
import type { EventAutomation } from "@/chat/event-automations/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Core-owned event namespace for Slack Events. Not a plugin publisher. */
export const SLACK_EVENT_NAMESPACE = "slack";

/** The trigger identifier that names the channel of the automation. */
export const SLACK_CURRENT_CHANNEL_IDENTIFIER = "current_channel";

const CHANNEL_RESOURCE_TYPE = "channel";
const MESSAGE_POSTED_EVENT = "message.posted";
const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{2,}$/;

/** Event registration for new top-level Slack channel messages. */
export function slackChannelMessageEvents(): Pick<
  PluginEvents,
  "resourceTypes"
> {
  return {
    resourceTypes: [
      {
        type: CHANNEL_RESOURCE_TYPE,
        identifier: {
          format: `"${SLACK_CURRENT_CHANNEL_IDENTIFIER}" for the channel where the automation is created`,
          pattern: /^(?:current_channel|[CG][A-Z0-9]{2,})$/,
        },
        supportedEvents: [MESSAGE_POSTED_EVENT],
        suggestedEvents: [],
        guidance: {
          [MESSAGE_POSTED_EVENT]:
            "A person posted a new top-level message in this channel. A reply goes in that message's thread. If the instructions do not apply to this message, end with no action.",
        },
      },
    ],
  };
}

/**
 * Bind a Slack channel-message automation to its own channel.
 *
 * Resolve `current_channel` to the destination channel and reject other
 * channels, so private channel text cannot reach another channel.
 */
export function requireSlackChannelMessageScope(
  automation: EventAutomation,
): EventAutomation {
  if (automation.trigger.namespace !== SLACK_EVENT_NAMESPACE) return automation;
  const channelId = automation.destination.channelId;
  const identifier =
    automation.trigger.identifier === SLACK_CURRENT_CHANNEL_IDENTIFIER
      ? channelId
      : automation.trigger.identifier;
  if (identifier !== channelId) {
    throw new ToolInputError(
      `A Slack channel-message automation can watch only the channel where it posts. Use identifier "${SLACK_CURRENT_CHANNEL_IDENTIFIER}", or create the automation in the channel to watch.`,
    );
  }
  return {
    ...automation,
    credentialMode: "system",
    trigger: { ...automation.trigger, identifier },
  };
}

/**
 * Build the Event for one new top-level channel message, or nothing.
 *
 * Thread replies and bot posts do not count. Bots can post often and use up
 * the run limit of the automation.
 */
export function slackChannelMessageEvent(input: {
  botId?: string;
  channelId: string;
  subtype?: string;
  text?: string;
  threadTs?: string;
  ts: string;
  userId: string;
}): EventInput | undefined {
  if (input.botId || input.subtype === "bot_message") return undefined;
  if (input.threadTs && input.threadTs !== input.ts) return undefined;
  if (!CHANNEL_ID_PATTERN.test(input.channelId)) return undefined;
  return {
    eventKey: `${input.channelId}:${input.ts}`,
    eventType: MESSAGE_POSTED_EVENT,
    identifier: input.channelId,
    occurredAtMs: Math.floor(Number(input.ts) * 1000),
    trustedSummary: `<@${input.userId}> posted a new message in <#${input.channelId}>.`,
    data: {
      channelId: input.channelId,
      messageTs: input.ts,
      userId: input.userId,
    },
    ...(input.text?.trim() ? { untrustedText: input.text } : undefined),
  };
}

/** Return the source message thread for a channel-message run. */
export function slackChannelMessageReplyThreadTs(
  event: Event,
): string | undefined {
  if (event.namespace !== SLACK_EVENT_NAMESPACE) return undefined;
  const messageTs = event.data?.messageTs;
  return typeof messageTs === "string" ? messageTs : undefined;
}
