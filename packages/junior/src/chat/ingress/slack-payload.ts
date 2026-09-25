import type {
  AppMentionEvent,
  AssistantThreadStartedEvent,
  GenericMessageEvent,
} from "@slack/types";
import { z } from "zod";

// Slack defines these on AppMentionEvent, but not GenericMessageEvent.
// Chat SDK's SlackEvent omits both. Validate them before checking membership.
export const slackAuthorTeamSchema = z.object({
  user_team: z.string().optional(),
  source_team: z.string().optional(),
}) satisfies z.ZodType<Pick<AppMentionEvent, "user_team" | "source_team">>;

export const slackAssistantThreadSchema = z.object({
  channel_id: z.string().min(1),
  thread_ts: z.string().min(1),
  user_id: z.string(),
  context: z.object({
    channel_id: z.string().optional(),
    team_id: z.string().optional(),
    enterprise_id: z.string().nullable().optional(),
  }),
}) satisfies z.ZodType<AssistantThreadStartedEvent["assistant_thread"]>;

type MessageFields = Partial<
  Pick<
    AppMentionEvent,
    | "blocks"
    | "bot_id"
    | "channel"
    | "event_ts"
    | "subtype"
    | "text"
    | "thread_ts"
    | "ts"
    | "user"
  > &
    Pick<GenericMessageEvent, "channel_type">
>;

// Validate fields that ingress reads. Keep other fields for Chat SDK parsing.
// Membership is checked separately so invalid author fields cannot fall back.
const slackEventSchema = z.looseObject({
  type: z.string(),
  blocks: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z
          .union([
            z.string(),
            z.looseObject({
              type: z.enum(["mrkdwn", "plain_text"]),
              text: z.string(),
            }),
          ])
          .optional(),
      }),
    )
    .optional(),
  bot_id: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z
    .enum(["channel", "group", "mpim", "im", "app_home"])
    .optional(),
  event_ts: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string().optional(),
  user: z.string().optional(),
}) satisfies z.ZodType<MessageFields>;

// @slack/types has event types, but no Events API envelope or interactive payload.
export const slackEventEnvelopeSchema = z.object({
  enterprise_id: z.string().optional(),
  event: slackEventSchema.optional(),
  is_enterprise_install: z.boolean().optional(),
  team_id: z.string().optional(),
  type: z.string(),
  challenge: z.string().optional(),
});

export type SlackEventEnvelope = z.output<typeof slackEventEnvelopeSchema>;
export type SlackInboundEvent = z.output<typeof slackEventSchema>;

export const slackInteractivePayloadSchema = z.object({
  actions: z
    .array(
      z.object({
        action_id: z.string().optional(),
        selected_option: z.object({ value: z.string().optional() }).optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
  team: z.object({ id: z.string().optional() }).nullish(),
  type: z.string(),
  user: z
    .object({ id: z.string().optional(), team_id: z.string().optional() })
    .optional(),
});

export type SlackInteractivePayload = z.output<
  typeof slackInteractivePayloadSchema
>;
