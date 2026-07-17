import { z } from "zod";

const slackActionTokenSchema = z
  .string()
  .trim()
  .min(1)
  .brand<"SlackActionToken">();

const slackMessageEnvelopeSchema = z.object({
  raw: z
    .object({
      action_token: z.unknown().optional(),
    })
    .optional(),
});

export type SlackActionToken = z.output<typeof slackActionTokenSchema>;

/** Parse the ephemeral search token from an untrusted Slack message envelope. */
export function readSlackActionToken(
  message: unknown,
): SlackActionToken | undefined {
  const envelope = slackMessageEnvelopeSchema.safeParse(message);
  if (!envelope.success) {
    return undefined;
  }
  const token = slackActionTokenSchema.safeParse(
    envelope.data.raw?.action_token,
  );
  return token.success ? token.data : undefined;
}
