/**
 * Open a Slack code channel for a new Thread, or say why not.
 * https://docs.slack.dev/ai/slack-code/lifecycle#creation
 */
import type { AgentRun } from "@/chat/agent/types";
import { setChannelThreadLocation } from "@/chat/conversations/sql/location";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { logInfo } from "@/chat/logging";
import {
  getConversationInfo,
  isPublicSlackChannel,
} from "@/chat/slack/channel";
import { readChannelLocationId } from "@/chat/slack/continue-in-slack";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import { createCodeChannel } from "./api";

/** The origin message of a code channel. */
type CodeChannelOrigin = {
  channelId: SlackChannelId;
  messageTs: string;
  teamId: SlackTeamId;
};

/**
 * Return the origin of a code channel for a Thread that this Run starts, or
 * undefined when the Thread must stay a plain Thread. The caller checks the
 * kinds (`opensChildChannel`). Only a Turn from a Slack message in a public
 * channel that is not shared with another
 * organization and is not itself a code channel qualifies. A live
 * `conversations.info` proves the channel is still public; stored visibility
 * can be stale.
 */
export async function readCodeChannelOrigin(
  run: Pick<AgentRun, "source">,
): Promise<CodeChannelOrigin | undefined> {
  if (!isExperimentalFeatureEnabled("code-channels")) return undefined;
  const { source } = run;
  const slack = source.kind === "slack" ? source : undefined;
  if (!slack?.messageTs) return undefined;
  const channelId = parseSlackChannelId(slack.channelId);
  const teamId = parseSlackTeamId(slack.teamId);
  if (!channelId || !teamId) return undefined;
  const info = await getConversationInfo(channelId);
  if (!isPublicSlackChannel(info) || info.isExtShared || info.isCodeChannel) {
    return undefined;
  }
  return { channelId, messageTs: slack.messageTs, teamId };
}

/**
 * Create the code channel of one Thread. The Thread's Conversation id is the
 * Slack `session_id`, so a retry returns the same channel. Returns undefined
 * when Slack refuses with an expected error; the Thread then starts as a
 * plain Thread and people see no error.
 */
export async function createThreadCodeChannel(args: {
  origin: CodeChannelOrigin;
  threadConversationId: string;
}): Promise<SlackChannelId | undefined> {
  const created = await createCodeChannel({
    originChannelId: args.origin.channelId,
    originMessageTs: args.origin.messageTs,
    sessionId: args.threadConversationId,
  });
  if (created.status === "fallback") {
    logInfo("slack.code_channel.fell_back", {
      "app.slack.api_error": created.error,
    });
    return undefined;
  }
  return created.channelId;
}

/**
 * Make a code channel the Location of its Thread and bind the whole channel
 * to it. Slack makes the channel public for a public origin.
 */
export async function bindThreadCodeChannel(args: {
  channelId: SlackChannelId;
  teamId: SlackTeamId;
  threadConversationId: string;
}): Promise<void> {
  const channel = { channelId: args.channelId, teamId: args.teamId };
  await getConversationStore().recordDestinationVisibility({
    destination: { platform: "slack", ...channel },
    visibility: "public",
  });
  const locationId = await readChannelLocationId(channel);
  const bound = await setChannelThreadLocation(getSqlExecutor(), {
    conversationId: args.threadConversationId,
    location: { id: locationId, provider: "slack", ...channel },
  });
  if (!bound) {
    throw new Error(
      `Code channel ${args.channelId} is bound to another Conversation`,
    );
  }
}
