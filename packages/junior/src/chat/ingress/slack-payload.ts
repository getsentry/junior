import type { SlackEvent as AdapterEvent } from "@chat-adapter/slack";
import type {
  AppMentionEvent,
  AssistantThreadStartedEvent,
  GenericMessageEvent,
} from "@slack/types";
import { z } from "zod";
import { slackMessageTsSchema } from "@/chat/slack/timestamp";
import {
  slackChannelIdSchema,
  slackTeamIdSchema,
  slackUserIdSchema,
} from "@/chat/slack/ids";

// Message dates must also fit JavaScript's Date range.
const eventTimestampSchema = slackMessageTsSchema.refine((value) =>
  Number.isFinite(new Date(Number(value) * 1_000).getTime()),
);

export const slackSlashCommandSchema = z.object({
  channel_id: z.string().trim().pipe(slackChannelIdSchema),
  team_id: z.string().trim().pipe(slackTeamIdSchema),
  user_id: z.string().trim().pipe(slackUserIdSchema),
  text: z.string(),
  enterprise_id: z.string().optional(),
  is_enterprise_install: z.enum(["true", "false"]).optional(),
});

export type SlackSlashCommandForm = z.output<typeof slackSlashCommandSchema>;

export const slackAssistantThreadSchema = z.object({
  channel_id: z.string().min(1),
  thread_ts: eventTimestampSchema,
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

// Validate fields read by ingress and the adapter's parseMessage/extractLinks.
// Preserve other fields, including nested blocks and files, for content projection.
// Membership is checked separately so invalid author fields cannot fall back.
const slackEventSchema = z.looseObject({
  type: z.string(),
  attachments: z
    .array(
      z.looseObject({
        from_url: z.string().optional(),
        original_url: z.string().optional(),
        title: z.string().optional(),
        text: z.string().optional(),
        image_url: z.string().optional(),
        thumb_url: z.string().optional(),
        service_name: z.string().optional(),
      }),
    )
    .optional(),
  files: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        mimetype: z.string().optional(),
        url_private: z.string().optional(),
        name: z.string().optional(),
        size: z.number().optional(),
        original_w: z.number().optional(),
        original_h: z.number().optional(),
      }),
    )
    .optional(),
  edited: z.looseObject({ ts: eventTimestampSchema }).optional(),
  team: z.string().optional(),
  team_id: z.string().optional(),
  username: z.string().optional(),
  blocks: z
    .array(
      z.looseObject({
        type: z.string(),
        elements: z
          .array(
            z.looseObject({
              type: z.string(),
              elements: z
                .array(
                  z.looseObject({
                    type: z.string(),
                    url: z.string().optional(),
                  }),
                )
                .optional(),
            }),
          )
          .optional(),
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
  event_ts: eventTimestampSchema.optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  thread_ts: eventTimestampSchema.optional(),
  ts: eventTimestampSchema.optional(),
  user: z.string().optional(),
}) satisfies z.ZodType<MessageFields & AdapterEvent>;

// @slack/types has event types, but no Events API envelope or interactive payload.
export const slackEventEnvelopeSchema = z.object({
  // Retain diagnostic fields without making them requirements for ingress.
  event_id: z.unknown().optional(),
  is_ext_shared_channel: z.unknown().optional(),
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
