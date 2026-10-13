/**
 * Slack channel-message Events for Event automations.
 *
 * A person posts a new top-level message in a channel. Event automations in
 * that same channel can run for it and reply in the message's thread. Core
 * publishes these Events from Slack ingress, so the `slack` namespace is core
 * owned, like `junior`.
 *
 * Anyone who can post in the channel controls the Event text. For this
 * reason, an automation can watch only the channel where it posts, and its
 * runs never get the creator's credentials.
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

/** Accept `<#C123|name>`, `#C123`, and `slack:C123` as `C123`. */
function normalizeChannelIdentifier(identifier: string): string {
  const mention = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$/.exec(identifier);
  if (mention) return mention[1]!;
  return identifier.replace(/^slack:/, "").replace(/^#/, "");
}

/** Event registration for new top-level Slack channel messages. */
export function slackChannelMessageEvents(): Pick<
  PluginEvents,
  "normalizeIdentifier" | "resourceTypes"
> {
  return {
    normalizeIdentifier: normalizeChannelIdentifier,
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

/** True when an Event or trigger is in the Slack namespace. */
function isSlackChannelMessage(input: { namespace: string }): boolean {
  return input.namespace === SLACK_EVENT_NAMESPACE;
}

/**
 * Bind a Slack channel-message automation to its own channel.
 *
 * Resolve `current_channel` to the destination channel and reject other
 * channels. A trigger on another channel could post private channel text in a
 * channel with other members. Runs always use system credentials, because the
 * Event text comes from anyone in the channel.
 */
export function requireSlackChannelMessageScope(
  automation: EventAutomation,
): EventAutomation {
  if (!isSlackChannelMessage(automation.trigger)) return automation;
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
 * Thread replies do not count. They belong to an existing discussion.
 */
export function slackChannelMessageEvent(input: {
  channelId: string;
  text?: string;
  threadTs?: string;
  ts: string;
  userId: string;
}): EventInput | undefined {
  if (input.threadTs && input.threadTs !== input.ts) return undefined;
  if (!CHANNEL_ID_PATTERN.test(input.channelId)) return undefined;
  const occurredAtMs = Math.floor(Number(input.ts) * 1000);
  return {
    eventKey: `${input.channelId}:${input.ts}`,
    eventType: MESSAGE_POSTED_EVENT,
    identifier: input.channelId,
    occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : Date.now(),
    trustedSummary: `<@${input.userId}> posted a new message in <#${input.channelId}>.`,
    data: {
      channelId: input.channelId,
      messageTs: input.ts,
      userId: input.userId,
    },
    ...(input.text?.trim() ? { untrustedText: input.text } : undefined),
  };
}

/**
 * Return the thread where a run for this Event replies.
 *
 * A channel-message run replies in the thread of the source message. Other
 * Events keep the stored channel-level destination.
 */
export function slackChannelMessageReplyThreadTs(
  automation: Pick<EventAutomation, "destination">,
  event: Event,
): string | undefined {
  if (!isSlackChannelMessage(event)) return undefined;
  if (event.identifier !== automation.destination.channelId) return undefined;
  const messageTs = event.data?.messageTs;
  return typeof messageTs === "string" ? messageTs : undefined;
}
