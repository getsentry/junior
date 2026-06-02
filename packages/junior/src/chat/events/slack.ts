import type {
  AgentEventDefinition,
  AgentEventEnvelope,
} from "@sentry/junior-plugin-api";
import { isConversationChannel } from "@/chat/slack/client";
import type { RegisteredAgentEventDefinition } from "@/chat/plugins/agent-hooks";

export const SLACK_CHANNEL_MESSAGE_CREATED_EVENT =
  "slack.channel.message.created";

const slackChannelMessageCreatedDefinition: AgentEventDefinition = {
  contextBlocks: {
    source_message: {
      description: "The Slack channel message that triggered the event.",
      render(ctx) {
        const text =
          typeof ctx.envelope.payload.text === "string"
            ? ctx.envelope.payload.text
            : "";
        const userId =
          typeof ctx.envelope.payload.userId === "string"
            ? ctx.envelope.payload.userId
            : "unknown";
        const channelId =
          typeof ctx.envelope.scope.channelId === "string"
            ? ctx.envelope.scope.channelId
            : "unknown";
        const messageTs =
          typeof ctx.envelope.payload.messageTs === "string"
            ? ctx.envelope.payload.messageTs
            : "unknown";
        return [
          `channel_id: ${channelId}`,
          `message_ts: ${messageTs}`,
          `user_id: ${userId}`,
          "text:",
          text,
        ].join("\n");
      },
    },
  },
  deliveryTargets: [{ target: "channel" }],
  filterKeys: ["actor", "text", "userId"],
  scopeKeys: ["channelId", "teamId"],
};

/** Return built-in platform events that installs may bind event prompts to. */
export function getBuiltinEventDefinitions(): RegisteredAgentEventDefinition[] {
  return [
    {
      event: SLACK_CHANNEL_MESSAGE_CREATED_EVENT,
      plugin: "slack",
      definition: slackChannelMessageCreatedDefinition,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsSlackUser(text: string, userId: string): boolean {
  return new RegExp(`<@${escapeRegExp(userId)}(?:\\|[^>]+)?>`).test(text);
}

/** Normalize a raw Slack root channel message into the event prompt envelope. */
export function extractSlackChannelMessageCreatedEnvelope(
  body: unknown,
  options: { botUserId: string },
): AgentEventEnvelope | undefined {
  if (!isRecord(body) || body.type !== "event_callback") {
    return undefined;
  }
  if (!options.botUserId) {
    return undefined;
  }
  const event = isRecord(body.event) ? body.event : undefined;
  if (!event || event.type !== "message") {
    return undefined;
  }
  if (event.subtype !== undefined) {
    return undefined;
  }

  const teamId = stringValue(body.team_id);
  const channelId = stringValue(event.channel);
  const channelType = stringValue(event.channel_type);
  const messageTs = stringValue(event.ts);
  const eventTs = stringValue(event.event_ts) ?? messageTs;
  const userId = stringValue(event.user);
  if (!teamId || !channelId || !channelType || !messageTs || !userId) {
    return undefined;
  }
  if (channelType !== "channel" && channelType !== "group") {
    return undefined;
  }
  if (!isConversationChannel(channelId)) {
    return undefined;
  }
  const threadTs = stringValue(event.thread_ts);
  if (threadTs && threadTs !== messageTs) {
    return undefined;
  }
  if (userId === options.botUserId) {
    return undefined;
  }

  const text = typeof event.text === "string" ? event.text : "";
  if (textMentionsSlackUser(text, options.botUserId)) {
    return undefined;
  }

  const sourceEventId =
    stringValue(body.event_id) ?? `${teamId}:${channelId}:${messageTs}`;
  const occurredAtMs =
    typeof body.event_time === "number" && Number.isFinite(body.event_time)
      ? body.event_time * 1000
      : Date.now();

  return {
    event: SLACK_CHANNEL_MESSAGE_CREATED_EVENT,
    sourceEventId,
    occurredAtMs,
    actor: {
      id: userId,
      type: "slack_user",
    },
    scope: {
      teamId,
      channelId,
    },
    payload: {
      actor: userId,
      teamId,
      channelId,
      messageTs,
      eventTs,
      userId,
      text,
    },
  };
}
