/**
 * Slack channel-message Events for Event automations.
 *
 * Core publishes these Events from Slack ingress, so the `slack` namespace is
 * core owned, like `junior`. Anyone in the channel writes the Event text, so an
 * automation can watch only its own channel and always uses system credentials.
 */
import {
  eventMatchFieldsSchema,
  type Event,
  type EventInput,
} from "@sentry/junior-plugin-api";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { EventRegistrationInput } from "@/chat/events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Core-owned event namespace for Slack Events. Not a plugin publisher. */
export const SLACK_EVENT_NAMESPACE = "slack";

const CHANNEL_RESOURCE_TYPE = "channel";
const MESSAGE_POSTED_EVENT = "message.posted";
const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{2,}$/;

const CHANNEL_MESSAGE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  channelId: {
    kind: "string",
    description:
      "Slack channel ID of the message. A channel automation always names the channel where it posts.",
  },
  userId: {
    kind: "string",
    description:
      "Slack user ID of the message author. Required to run on bot posts, such as alert bots.",
  },
});

/**
 * Event registration for new top-level Slack channel messages. Only event
 * automations can use it, so watchEvents rejects it.
 */
export function slackChannelMessageEvents(): EventRegistrationInput {
  return {
    resourceTypes: [
      {
        type: CHANNEL_RESOURCE_TYPE,
        identifier: {
          format: "Slack channel ID",
          pattern: String.raw`^[CG][A-Z0-9]{2,}$`,
        },
        supportedEvents: [MESSAGE_POSTED_EVENT],
        suggestedEvents: [],
        matchFields: CHANNEL_MESSAGE_MATCH_FIELDS,
      },
    ],
    events: {
      // A channel automation stays in its own channel.
      // `requireSlackChannelMessageScope` always sets the `channelId` filter
      // to the channel where the automation posts, so a trigger needs no
      // filter from the agent and can never reach another channel.
      [MESSAGE_POSTED_EVENT]: {
        reach: "all",
        guidance:
          "A person or bot posted a new top-level message in this channel. A bot post runs the automation only when match names the bot in userId. A reply goes in that message's thread. If the instructions do not apply to this message, end with no action.",
      },
    },
    limits: {
      [CHANNEL_RESOURCE_TYPE]: {
        watch: false,
        watchUnavailableMessage:
          "Slack channel messages can trigger only an event automation in that channel. Use createAutomation with an event trigger.",
      },
    },
  };
}

/**
 * Bind a Slack channel-message automation to its own channel.
 *
 * A new trigger has no identifier, and its `channelId` filter is set to the
 * channel where the automation posts. A trigger that was saved with an
 * identifier keeps it. Reject other channels, so private channel text cannot
 * reach another channel.
 */
export function requireSlackChannelMessageScope(
  automation: EventAutomation,
): EventAutomation {
  if (automation.trigger.namespace !== SLACK_EVENT_NAMESPACE) return automation;
  const channelId = automation.destination.channelId;
  if (!CHANNEL_ID_PATTERN.test(channelId)) {
    throw new ToolInputError(
      "A Slack channel-message automation works only in a channel, not in a DM.",
    );
  }
  const { identifier, match } = automation.trigger;
  const named = [identifier, match?.channelId].filter(
    (value) => value !== undefined,
  );
  if (named.some((value) => value !== channelId)) {
    throw new ToolInputError(
      "A Slack channel-message automation can watch only the channel where it posts. Create the automation in the channel to watch.",
    );
  }
  return {
    ...automation,
    credentialMode: "system",
    trigger:
      identifier === undefined
        ? { ...automation.trigger, match: { ...match, channelId } }
        : automation.trigger,
  };
}

/**
 * Build the Event for one new top-level channel message, or nothing.
 *
 * Thread replies and Slackbot posts do not count. Other bot posts are marked
 * with `postedByBot`, so only automations that name the bot can run on them.
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
  if (input.userId === "USLACKBOT") return undefined;
  if (input.threadTs && input.threadTs !== input.ts) return undefined;
  if (!CHANNEL_ID_PATTERN.test(input.channelId)) return undefined;
  const postedByBot = Boolean(input.botId || input.subtype === "bot_message");
  return {
    eventKey: `${input.channelId}:${input.ts}`,
    eventType: MESSAGE_POSTED_EVENT,
    identifier: input.channelId,
    occurredAtMs: Math.floor(Number(input.ts) * 1000),
    trustedSummary: `${postedByBot ? "The bot " : ""}<@${input.userId}> posted a new message in <#${input.channelId}>.`,
    data: {
      channelId: input.channelId,
      messageTs: input.ts,
      userId: input.userId,
      ...(postedByBot ? { postedByBot: true } : undefined),
    },
    ...(input.text?.trim() ? { untrustedText: input.text } : undefined),
  };
}

/**
 * Decide whether a channel-message Event may run one automation.
 *
 * A message runs only automations that post in its own channel, so private
 * channel text cannot reach another channel. The `channelId` filter already
 * names that channel, and this check keeps the rule when it does not.
 * A bot post runs only automations whose match names its author in `userId`.
 * Bots can post often and would use up the run limit of every other
 * automation in the channel.
 */
export function slackChannelMessageRunsAutomation(
  event: Event,
  automation: EventAutomation,
): boolean {
  if (event.namespace !== SLACK_EVENT_NAMESPACE) return true;
  if (event.data?.channelId !== automation.destination.channelId) return false;
  if (event.data?.postedByBot !== true) return true;
  return automation.trigger.match?.userId !== undefined;
}

/** Return the source message thread for a channel-message run. */
export function slackChannelMessageReplyThreadTs(
  event: Event,
): string | undefined {
  if (event.namespace !== SLACK_EVENT_NAMESPACE) return undefined;
  const messageTs = event.data?.messageTs;
  return typeof messageTs === "string" ? messageTs : undefined;
}
