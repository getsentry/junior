import { Type } from "@sinclair/typebox";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

type SlackTimestampParamResult =
  | { ok: true; value: SlackMessageTs | undefined }
  | { ok: false; error: string };

type RequiredSlackTimestampParamResult =
  | { ok: true; value: SlackMessageTs }
  | { ok: false; error: string };

/** Define a model-facing Slack timestamp string parameter. */
export function slackTimestampParam(description: string) {
  return Type.String({
    minLength: 1,
    description,
  });
}

/** Define an optional model-facing Slack timestamp string parameter. */
export function optionalSlackTimestampParam(description: string) {
  return Type.Optional(slackTimestampParam(description));
}

/** Parse tool input into a branded Slack timestamp before provider calls. */
export function parseSlackTimestampParam(
  field: string,
  value: string | undefined,
): SlackTimestampParamResult {
  if (!value) {
    return { ok: true, value: undefined };
  }

  const timestamp = parseSlackMessageTs(value);
  if (timestamp) {
    return { ok: true, value: timestamp };
  }

  return {
    ok: false,
    error: `Invalid \`${field}\` Slack timestamp. Use a numeric Slack ts like \`1712345678.123456\`.`,
  };
}

/** Parse a required tool input timestamp into a branded Slack timestamp. */
export function parseRequiredSlackTimestampParam(
  field: string,
  value: string,
): RequiredSlackTimestampParamResult {
  const timestamp = parseSlackMessageTs(value);
  if (timestamp) {
    return { ok: true, value: timestamp };
  }

  return {
    ok: false,
    error: `Invalid \`${field}\` Slack timestamp. Use a numeric Slack ts like \`1712345678.123456\`.`,
  };
}
