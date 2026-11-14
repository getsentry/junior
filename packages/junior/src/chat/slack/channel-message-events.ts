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
import type { SlackBotId } from "@/chat/slack/ids";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Core-owned event namespace for Slack Events. Not a plugin publisher. */
export const SLACK_EVENT_NAMESPACE = "slack";

/** The trigger identifier that names the channel of the automation. */
export const SLACK_CURRENT_CHANNEL_IDENTIFIER = "current_channel";

const CHANNEL_RESOURCE_TYPE = "channel";
const MESSAGE_POSTED_EVENT = "message.posted";
const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{2,}$/;
const CHANNEL_LOCATION = "channel";
const THREAD_LOCATION = "thread";

const CHANNEL_MESSAGE_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  channelId: {
    kind: "string",
    description:
      "Slack channel ID of the message. It is always the channel where the automation posts.",
    events: [MESSAGE_POSTED_EVENT],
  },
  userId: {
    kind: "string",
    description:
      "Slack user ID of the message author, or the bot ID (B…) of a bot post that has no user, such as an app integration. Required to run on bot posts.",
  },
  location: {
    kind: "string",
    enum: [CHANNEL_LOCATION, THREAD_LOCATION],
    description:
      "channel for a top-level message, thread for a thread reply. Leave out for top-level only; thread replies run only when this names thread.",
  },
});

/**
 * Event registration for new Slack channel messages and thread replies. Only
 * event automations can use it, so watchEvents rejects it.
 */
export function slackChannelMessageEvents(): EventRegistrationInput {
  return {
    resourceTypes: [
      {
        type: CHANNEL_RESOURCE_TYPE,
        identifier: {
          format: `"${SLACK_CURRENT_CHANNEL_IDENTIFIER}" for the channel where the automation is created`,
          pattern: String.raw`^(?:current_channel|[CG][A-Z0-9]{2,})$`,
        },
        supportedEvents: [MESSAGE_POSTED_EVENT],
        suggestedEvents: [],
        matchFields: CHANNEL_MESSAGE_MATCH_FIELDS,
      },
    ],
    events: {
      // A channel automation stays in its own channel.
      // `slackChannelMessageTrigger` sets the `channelId` filter.
      [MESSAGE_POSTED_EVENT]: {
        reach: { anyOf: ["channelId"] },
        guidance:
          "A person or bot posted a new message in this channel. A bot post runs the automation only when match names the bot in user_id, by its user ID or, for a post with no user, its bot ID. A thread reply runs it only when match.location names thread. A reply goes in the message's Slack thread. If the instructions do not apply to this message, end with no action.",
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
 * Set the `channelId` filter of a Slack channel-message trigger to the
 * channel where the automation posts. A trigger that names another channel,
 * or a saved trigger with an identifier, stays as it is for
 * `requireSlackChannelMessageScope` to check.
 */
export function slackChannelMessageTrigger<
  T extends {
    identifier?: string | null;
    match?: EventAutomation["trigger"]["match"];
    namespace: string;
  },
>(trigger: T, channelId: string): T {
  if (trigger.namespace !== SLACK_EVENT_NAMESPACE) return trigger;
  if (
    trigger.identifier != null ||
    trigger.match?.["channelId"] !== undefined
  ) {
    return trigger;
  }
  return { ...trigger, match: { ...trigger.match, channelId } };
}

/**
 * Bind a Slack channel-message automation to its own channel.
 *
 * The trigger names the channel with a `channelId` filter. A saved trigger
 * can name it with an identifier instead, where `current_channel` means the
 * destination channel. Reject other channels, so private channel text cannot
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
  const named =
    identifier === undefined
      ? match?.["channelId"]
      : identifier === SLACK_CURRENT_CHANNEL_IDENTIFIER
        ? channelId
        : identifier;
  if (named !== channelId) {
    throw new ToolInputError(
      "A Slack channel-message automation can watch only the channel where it posts. Leave out the channel_id filter, or create the automation in the channel to watch.",
    );
  }
  return {
    ...automation,
    credentialMode: "system",
    trigger: {
      ...automation.trigger,
      ...(identifier === undefined ? undefined : { identifier: channelId }),
    },
  };
}

/**
 * Author of a channel message: a Slack user, or the bot of a post that has a
 * bot ID and no user, such as an app integration.
 */
export type SlackChannelMessageAuthor =
  | { kind: "user"; userId: string }
  | { kind: "bot"; botId: SlackBotId };

/**
 * Build the Event for one new channel message or thread reply, or nothing.
 *
 * Slackbot posts do not count. Bot posts are marked with `postedByBot`, so
 * only automations that name the bot can run on them. Thread replies carry
 * the `thread` location, so only automations that name it can run on them.
 */
export function slackChannelMessageEvent(input: {
  author: SlackChannelMessageAuthor;
  botId?: string;
  channelId: string;
  subtype?: string;
  text?: string;
  threadTs?: string;
  ts: string;
}): EventInput | undefined {
  const { author } = input;
  if (author.kind === "user" && author.userId === "USLACKBOT") return undefined;
  if (!CHANNEL_ID_PATTERN.test(input.channelId)) return undefined;
  const postedByBot =
    author.kind === "bot" ||
    Boolean(input.botId || input.subtype === "bot_message");
  const userId = author.kind === "bot" ? author.botId : author.userId;
  const threadTs =
    input.threadTs && input.threadTs !== input.ts ? input.threadTs : undefined;
  return {
    eventKey: `${input.channelId}:${input.ts}`,
    eventType: MESSAGE_POSTED_EVENT,
    identifier: input.channelId,
    occurredAtMs: Math.floor(Number(input.ts) * 1000),
    trustedSummary: `${postedByBot ? "The bot " : ""}${author.kind === "bot" ? author.botId : `<@${author.userId}>`} posted a new ${threadTs ? `thread reply under message ${threadTs}` : "message"} in <#${input.channelId}>.`,
    data: {
      channelId: input.channelId,
      location: threadTs ? THREAD_LOCATION : CHANNEL_LOCATION,
      messageTs: input.ts,
      ...(threadTs ? { threadTs } : undefined),
      userId,
      ...(postedByBot ? { postedByBot: true } : undefined),
    },
    ...(input.text?.trim() ? { untrustedText: input.text } : undefined),
  };
}

/**
 * Decide whether a channel-message Event may run one automation.
 *
 * A message runs only automations that post in its own channel, so private
 * channel text cannot reach another channel. The trigger already names that
 * channel, and this check keeps the rule when it does not.
 * A bot post runs only automations whose match names its author in `userId`.
 * Bots can post often and would use up the run limit of every other
 * automation in the channel. A thread reply runs only automations whose
 * match names the `thread` location, so existing automations stay top-level.
 */
export function slackChannelMessageRunsAutomation(
  event: Event,
  automation: EventAutomation,
): boolean {
  if (event.namespace !== SLACK_EVENT_NAMESPACE) return true;
  if (event.data?.["channelId"] !== automation.destination.channelId)
    return false;
  if (
    event.data?.["location"] === THREAD_LOCATION &&
    ![automation.trigger.match?.["location"]].flat().includes(THREAD_LOCATION)
  ) {
    return false;
  }
  if (event.data?.["postedByBot"] !== true) return true;
  return automation.trigger.match?.["userId"] !== undefined;
}

/** Return the source message thread for a channel-message run. */
export function slackChannelMessageReplyThreadTs(
  event: Event,
): string | undefined {
  if (event.namespace !== SLACK_EVENT_NAMESPACE) return undefined;
  const messageTs = event.data?.["threadTs"] ?? event.data?.["messageTs"];
  return typeof messageTs === "string" ? messageTs : undefined;
}
