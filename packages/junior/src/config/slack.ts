// The Slack group: the Slack app credentials and reaction emojis.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { optionCheck, type Env } from "@/config/fields";

const DEFAULT_PROCESSING_REACTION_EMOJI = "eyes";
const DEFAULT_COMPLETED_REACTION_EMOJI = "white_check_mark";

// Only createApp options set the reaction emojis. A blank one keeps the
// default.
function reactionEmoji(option: string, defaultEmoji: string) {
  return z
    .string()
    .transform((value, ctx) => {
      if (!value.trim()) {
        return defaultEmoji;
      }
      const normalized = normalizeSlackEmojiName(value);
      if (normalized) {
        return normalized;
      }
      ctx.addIssue({
        code: "custom",
        ...optionCheck(
          `${option} must be a valid Slack emoji name (for example "eyes" or ":white_check_mark:")`,
        ),
      });
      return z.NEVER;
    })
    .default(defaultEmoji);
}

/** The Slack app credentials and reaction emojis. */
export const slackSchema = z
  .strictObject({
    botToken: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    completedReactionEmoji: reactionEmoji(
      "completedReactionEmoji",
      DEFAULT_COMPLETED_REACTION_EMOJI,
    ),
    processingReactionEmoji: reactionEmoji(
      "processingReactionEmoji",
      DEFAULT_PROCESSING_REACTION_EMOJI,
    ),
    signingSecret: z.string().optional(),
  })
  .prefault({});

/** Env var that sets each Slack field, for error messages. */
export const slackEnvNames: Record<string, string> = {
  "slack.botToken": "SLACK_BOT_TOKEN",
  "slack.clientId": "SLACK_CLIENT_ID",
  "slack.clientSecret": "SLACK_CLIENT_SECRET",
  "slack.signingSecret": "SLACK_SIGNING_SECRET",
};

/** Read the Slack group from env. */
export function readSlackEnv(env: Env) {
  return {
    botToken:
      toOptionalTrimmed(env["SLACK_BOT_TOKEN"]) ??
      toOptionalTrimmed(env["SLACK_BOT_USER_TOKEN"]),
    clientId: toOptionalTrimmed(env["SLACK_CLIENT_ID"]),
    clientSecret: toOptionalTrimmed(env["SLACK_CLIENT_SECRET"]),
    signingSecret: toOptionalTrimmed(env["SLACK_SIGNING_SECRET"]),
  };
}
