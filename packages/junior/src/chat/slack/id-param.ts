import {
  parseSlackChannelId,
  parseSlackUserId,
  type SlackChannelId,
  type SlackUserId,
} from "@/chat/slack/ids";
import { z } from "zod";

type RequiredSlackChannelIdParamResult =
  | { ok: true; value: SlackChannelId }
  | { ok: false; error: string };

type RequiredSlackUserIdParamResult =
  | { ok: true; value: SlackUserId }
  | { ok: false; error: string };

// Tool schemas stay model-facing strings; execution parses those values into
// Zod-branded Slack IDs before provider calls.
/** Define a model-facing Slack channel ID parameter. */
export function slackChannelIdParam(description: string) {
  return z.string().min(1).describe(description);
}

/** Define a model-facing Slack user ID parameter. */
export function slackUserIdParam(description: string) {
  return z.string().min(1).describe(description);
}

/** Parse a required tool input channel ID into a branded Slack channel ID. */
export function parseRequiredSlackChannelIdParam(
  field: string,
  value: unknown,
): RequiredSlackChannelIdParamResult {
  const channelId = parseSlackChannelId(value);
  if (channelId) {
    return { ok: true, value: channelId };
  }

  return {
    ok: false,
    error: `Invalid \`${field}\` Slack channel ID. Use a Slack conversation ID like \`C123\`, \`G123\`, or \`D123\`.`,
  };
}

/** Parse a required tool input user ID into a branded Slack user ID. */
export function parseRequiredSlackUserIdParam(
  field: string,
  value: unknown,
): RequiredSlackUserIdParamResult {
  const userId = parseSlackUserId(value);
  if (userId) {
    return { ok: true, value: userId };
  }

  return {
    ok: false,
    error: `Invalid \`${field}\` Slack user ID. Use a Slack user ID like \`U123\` or \`W123\`.`,
  };
}
