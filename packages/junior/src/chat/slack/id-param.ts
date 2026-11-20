import { parseSlackUserId, type SlackUserId } from "@/chat/slack/ids";
import * as z from "zod";

type RequiredSlackUserIdParamResult =
  | { ok: true; value: SlackUserId }
  | { ok: false; error: string };

// Tool schemas stay model-facing strings; execution parses those values into
// Zod-branded Slack IDs before provider calls.
/** Define a model-facing Slack user ID parameter. */
export function slackUserIdParam(description: string) {
  return z.string().min(1).describe(description);
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
