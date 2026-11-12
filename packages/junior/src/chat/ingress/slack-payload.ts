import type { SlackEvent as AdapterEvent } from "@chat-adapter/slack";
import type {
  AppMentionEvent,
  AssistantThreadStartedEvent,
  GenericMessageEvent,
} from "@slack/types";
import * as z from "zod";
import { slackTeamIdSchema } from "@/chat/slack/ids";
import { slackMessageTsSchema } from "@/chat/slack/timestamp";

// Message dates must also fit JavaScript's Date range.
const eventTimestampSchema = slackMessageTsSchema.refine((value) =>
  Number.isFinite(new Date(Number(value) * 1_000).getTime()),
);

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
  context_enterprise_id: z.unknown().optional(),
  context_team_id: z.unknown().optional(),
  enterprise_id: z.string().optional(),
  event: slackEventSchema.optional(),
  is_enterprise_install: z.boolean().optional(),
  team_id: z.string().optional(),
  type: z.string(),
  challenge: z.string().optional(),
});

export type SlackEventEnvelope = z.output<typeof slackEventEnvelopeSchema>;
export type SlackInboundEvent = z.output<typeof slackEventSchema>;

/**
 * Where an event happened, from the signed envelope. `external` is a channel
 * shared with another organization. `workspace` is a channel that only the
 * receiving workspace can post in. `enterprise` is a channel in this
 * workspace of an Enterprise Grid org, which other workspaces of the org can
 * also post in when the channel is shared across the org. Other envelopes
 * are `unknown`.
 */
export type SlackChannelScope =
  | "workspace"
  | "enterprise"
  | "external"
  | "unknown";

// https://docs.slack.dev/apis/events-api#callback-field
const workspaceChannelSchema = z.object({
  context_enterprise_id: z.string().nullish(),
  context_team_id: slackTeamIdSchema,
  enterprise_id: z.string().optional(),
  is_ext_shared_channel: z.literal(false),
  team_id: slackTeamIdSchema,
});

/** Read the channel scope of an event from its envelope. */
export function slackChannelScope(body: SlackEventEnvelope): SlackChannelScope {
  if (body.is_ext_shared_channel === true) return "external";
  const parsed = workspaceChannelSchema.safeParse(body);
  if (!parsed.success || parsed.data.context_team_id !== parsed.data.team_id) {
    return "unknown";
  }
  const enterpriseId = parsed.data.context_enterprise_id;
  if (enterpriseId == null) return "workspace";
  return enterpriseId === parsed.data.enterprise_id ? "enterprise" : "unknown";
}

// Keep these fields loose. Each handler validates the fields it needs, so
// one unusual payload shape does not reject unrelated interactions.
// https://docs.slack.dev/reference/interaction-payloads/block_actions-payload
// https://docs.slack.dev/reference/interaction-payloads/view-interactions-payload
const slackViewStateValueSchema = z.object({
  selected_option: z.object({ value: z.string().optional() }).nullish(),
  selected_options: z
    .array(z.object({ value: z.string().optional() }))
    .nullish(),
  value: z.string().nullish(),
});

export const slackInteractivePayloadSchema = z.object({
  actions: z
    .array(
      z.object({
        action_id: z.string().optional(),
        action_ts: z.string().optional(),
        selected_option: z.object({ value: z.string().optional() }).optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
  channel: z.object({ id: z.string().optional() }).nullish(),
  message: z
    .object({
      thread_ts: z.string().optional(),
      ts: z.string().optional(),
    })
    .nullish(),
  team: z.object({ id: z.string().optional() }).nullish(),
  trigger_id: z.string().optional(),
  type: z.string(),
  user: z
    .object({ id: z.string().optional(), team_id: z.string().optional() })
    .optional(),
  view: z
    .object({
      callback_id: z.string().optional(),
      id: z.string().optional(),
      private_metadata: z.string().optional(),
      state: z
        .object({
          values: z.record(
            z.string(),
            z.record(z.string(), slackViewStateValueSchema),
          ),
        })
        .optional(),
    })
    .nullish(),
});

export type SlackInteractivePayload = z.output<
  typeof slackInteractivePayloadSchema
>;
