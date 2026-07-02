import { z } from "zod";

/** Native Slack message timestamp, safe to pass as Slack Web API `message_ts`. */
export const slackMessageTsSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/)
  .brand<"SlackMessageTs">();

export type SlackMessageTs = z.output<typeof slackMessageTsSchema>;

/** Parse a native Slack message timestamp from untrusted message metadata. */
export function parseSlackMessageTs(
  value: unknown,
): SlackMessageTs | undefined {
  const parsed = slackMessageTsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
