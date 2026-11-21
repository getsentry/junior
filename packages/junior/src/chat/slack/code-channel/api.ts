/**
 * Slack Web API calls for code channels.
 * https://docs.slack.dev/ai/slack-code/lifecycle
 */
import * as z from "zod";
import {
  getSlackClient,
  SlackActionError,
  withSlackRetries,
} from "@/chat/slack/client";
import { parseSlackChannelId, type SlackChannelId } from "@/chat/slack/ids";

const createResponseSchema = z.object({
  channel_id: z.string().min(1),
});

/**
 * Errors after which Junior starts a plain Thread instead. Slack made no
 * channel, or Slack does not let this app or this person use code channels.
 * https://docs.slack.dev/reference/methods/agents.conversations.create#errors
 */
const FALLBACK_ERRORS = new Set([
  "channel_not_viewable",
  "feature_disabled",
  "invalid_origin_link",
  "missing_scope",
  "origin_channel_externally_shared",
  "origin_channel_is_file_channel",
  "ratelimited",
  "restricted_action",
  "user_not_enabled",
]);

/**
 * Errors after which the channel exists. Slack has already posted its card in
 * the origin Slack thread, so a retry with the same `session_id` returns it.
 */
const CHANNEL_EXISTS_ERRORS = new Set(["invite_failed", "open_failed"]);

type CreateCodeChannelResult =
  | { status: "created"; channelId: SlackChannelId }
  | { status: "fallback"; error: string };

async function callCreate(args: {
  originChannelId: SlackChannelId;
  originMessageTs: string;
  sessionId: string;
}): Promise<SlackChannelId> {
  const response = await withSlackRetries(
    () =>
      getSlackClient().apiCall("agents.conversations.create", {
        origin_channel_id: args.originChannelId,
        origin_message_ts: args.originMessageTs,
        session_id: args.sessionId,
      }),
    // Slack applies special rate limits here. A limit falls back instead of
    // holding the spawn.
    1,
    { action: "agents.conversations.create", idempotent: true },
  );
  const channelId = parseSlackChannelId(
    createResponseSchema.parse(response).channel_id,
  );
  if (!channelId) {
    throw new Error("agents.conversations.create returned no channel id");
  }
  return channelId;
}

function slackErrorCode(error: unknown): string | undefined {
  if (!(error instanceof SlackActionError)) return undefined;
  return error.code === "rate_limited" ? "ratelimited" : error.apiError;
}

/**
 * Create the code channel of one agent session from its origin message.
 * `sessionId` makes the call idempotent: a retry returns the same channel.
 * The origin privacy decides the channel privacy, so a public origin makes a
 * public channel. An unexpected error throws.
 * https://docs.slack.dev/reference/methods/agents.conversations.create
 */
export async function createCodeChannel(args: {
  originChannelId: SlackChannelId;
  originMessageTs: string;
  sessionId: string;
}): Promise<CreateCodeChannelResult> {
  try {
    return { status: "created", channelId: await callCreate(args) };
  } catch (error) {
    const code = slackErrorCode(error);
    if (code && FALLBACK_ERRORS.has(code)) {
      return { status: "fallback", error: code };
    }
    if (!code || !CHANNEL_EXISTS_ERRORS.has(code)) {
      throw error;
    }
  }
  return { status: "created", channelId: await callCreate(args) };
}

export type CodeChannelSessionStatus = "active" | "processing" | "suspended";

/**
 * Set the session status of a code channel. The whole channel is one
 * session, so the call names no `thread_ts`.
 * https://docs.slack.dev/reference/methods/agents.sessions.setStatus
 */
export async function setCodeChannelStatus(args: {
  channelId: string;
  status: CodeChannelSessionStatus;
}): Promise<void> {
  await withSlackRetries(
    () =>
      getSlackClient().apiCall("agents.sessions.setStatus", {
        channel_id: args.channelId,
        status: args.status,
      }),
    3,
    { action: "agents.sessions.setStatus", idempotent: true },
  );
}
