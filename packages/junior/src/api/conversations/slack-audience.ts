import type { User } from "@sentry/junior-plugin-api";
import { FAN_OUT_CONCURRENCY, mapBounded } from "@/chat/fan-out";
import { logWarn } from "@/chat/logging";
import {
  runWithSlackInstallation,
  SlackInstallationMissingError,
} from "@/chat/slack/adapter-context";
import { isConversationMember } from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import {
  getStateAdapter,
  getStateValues,
  setStateValues,
} from "@/chat/state/adapter";

/*
 * A Slack-backed private Conversation follows its Slack channel, DM, or
 * group DM (`policies/conversation-access.md`): whoever is in it now reads
 * the Conversation, and whoever leaves it loses access. Junior has no Slack
 * token of the viewer, so the bot asks Slack whether the viewer's linked
 * Slack user is a member.
 *
 * The dashboard reads a detail every few seconds, so each answer is shared
 * across instances for a short time. A person removed from the channel
 * loses access within that time. Only answers from Slack are shared, so a
 * failed check, or a workspace with no installation, denies access for that
 * request only.
 */
const MEMBERSHIP_TTL_MS = 60 * 1000;

/** The root Destination fields that decide whether a row follows Slack. */
export interface SlackAudienceRow {
  conversationId: string;
  provider: string | null;
  providerDestinationId: string | null;
  providerTenantId: string | null;
  spaceVisibility: string | null;
  visibility: string | null;
}

function membershipKey(teamId: string, channelId: string, userId: string) {
  return `slack-channel-member:${teamId}:${channelId}:${userId}`;
}

/**
 * Return, for each Slack-backed private row, whether the viewer is in its
 * Slack channel now. Rows that do not follow Slack are missing. A private
 * Space owns its own audience, so its rows are missing too.
 */
export async function readSlackChannelAudience(
  rows: readonly SlackAudienceRow[],
  viewer: User,
): Promise<Map<string, boolean>> {
  const channels = new Map<
    string,
    {
      channelId: SlackChannelId;
      conversationIds: string[];
      teamId: SlackTeamId;
    }
  >();
  for (const row of rows) {
    if (
      row.provider !== "slack" ||
      row.visibility === "public" ||
      row.spaceVisibility === "private"
    ) {
      continue;
    }
    const teamId = parseSlackTeamId(row.providerTenantId ?? "");
    const channelId = parseSlackChannelId(row.providerDestinationId ?? "");
    if (!teamId || !channelId) continue;
    const key = `${teamId}:${channelId}`;
    const channel = channels.get(key) ?? {
      channelId,
      conversationIds: [],
      teamId,
    };
    channel.conversationIds.push(row.conversationId);
    channels.set(key, channel);
  }
  const audience = new Map<string, boolean>();
  if (channels.size === 0) return audience;

  // A viewer may link more than one Slack account in a workspace. They are
  // in the channel when any of them is.
  const checks = [...channels.values()].flatMap((channel) =>
    viewer.identities
      .filter(
        (identity) =>
          identity.provider === "slack" &&
          identity.providerTenantId === channel.teamId,
      )
      .map((identity) => ({
        channelId: channel.channelId,
        key: membershipKey(
          channel.teamId,
          channel.channelId,
          identity.providerSubjectId,
        ),
        teamId: channel.teamId,
        userId: identity.providerSubjectId,
      })),
  );
  const state = getStateAdapter();
  const values = await getStateValues(
    state,
    checks.map((check) => check.key),
  );
  const answers = await mapBounded(
    checks,
    async (check, index) => {
      const cached = values[index];
      if (typeof cached === "boolean") return cached;
      const member = await checkMembership(
        check.teamId,
        check.channelId,
        check.userId,
      );
      if (member === undefined) return false;
      await setStateValues(
        state,
        [{ key: check.key, value: member }],
        MEMBERSHIP_TTL_MS,
      );
      return member;
    },
    FAN_OUT_CONCURRENCY,
  );
  const memberKeys = new Set(
    checks.flatMap((check, index) =>
      answers[index] ? [`${check.teamId}:${check.channelId}`] : [],
    ),
  );
  // A viewer with no Slack account in the workspace is in no channel.
  for (const [key, channel] of channels) {
    for (const conversationId of channel.conversationIds) {
      audience.set(conversationId, memberKeys.has(key));
    }
  }
  return audience;
}

/** Ask Slack. Undefined when Slack gave no answer, which denies access. */
async function checkMembership(
  teamId: SlackTeamId,
  channelId: SlackChannelId,
  userId: string,
): Promise<boolean | undefined> {
  // Access checks are imported widely. Load the Slack app only when a
  // Slack-backed private row needs it.
  const { getProductionSlackAdapter } = await import("@/chat/app/production");
  try {
    return await runWithSlackInstallation({
      adapter: getProductionSlackAdapter(),
      installation: { teamId },
      task: () => isConversationMember(channelId, userId),
    });
  } catch (error) {
    if (
      !(error instanceof SlackActionError) &&
      !(error instanceof SlackInstallationMissingError)
    ) {
      throw error;
    }
    logWarn("conversation_access.slack_membership.unavailable", {
      "app.slack.team_id": teamId,
      "exception.message": error.message,
    });
    return undefined;
  }
}
