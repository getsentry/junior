import { getConversationStore } from "@/chat/db";
import {
  parseSlackChannelId,
  parseSlackChannelReferenceId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import { z } from "zod";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export interface ResolvedSlackChannelTarget {
  channelId: SlackChannelId;
  channelName?: string;
}

// Slack channel names max out at 80 chars. Mentions add `<#id|…>` markup around
// that name, so the model-facing param must clear bare-name length.
const SLACK_CHANNEL_REF_MAX_LENGTH = 160;

/** Model-facing Slack channel id or known channel name parameter. */
export const slackChannelRefParam = z
  .string()
  .trim()
  .min(1)
  .max(SLACK_CHANNEL_REF_MAX_LENGTH)
  .describe(
    "Slack channel id (`C123`), mention (`<#C123>` / `<#C123|name>`), Junior slack reference (`slack:C123`), or a channel name Junior already knows in this workspace.",
  );

/**
 * Resolve a channel reference from a tool param value.
 *
 * Prefer id-bearing forms. Plain names may match one known destination already
 * stored for this workspace. Do not scan Slack's public channel list.
 */
export async function resolveSlackChannelRef(input: {
  field: string;
  value: string;
  teamId: SlackTeamId;
}): Promise<ResolvedSlackChannelTarget> {
  const trimmed = input.value.trim();
  if (!trimmed) {
    throw new ToolInputError(
      `Invalid \`${input.field}\`. Use a channel id (\`C123\`), a Slack mention (\`<#C123>\`), a Junior slack reference (\`slack:C123\`), or a channel name Junior already knows.`,
    );
  }

  const channelId = parseSlackChannelReferenceId(trimmed);
  if (channelId) {
    return { channelId };
  }

  const known = await getConversationStore().findSlackDestinationByName({
    teamId: input.teamId,
    channelName: trimmed,
  });
  const knownChannelId = known
    ? parseSlackChannelId(known.channelId)
    : undefined;
  if (known && knownChannelId) {
    return {
      channelId: knownChannelId,
      ...(known.channelName ? { channelName: known.channelName } : {}),
    };
  }

  throw new ToolInputError(
    `Unknown \`${input.field}\` \`${trimmed}\`. Use a channel id (\`C123\`), a Slack mention (\`<#C123>\`), a link, or a channel name Junior has already seen in this workspace. Public search can discover channels; plain names are not scanned from Slack.`,
  );
}

/**
 * Resolve an optional channel reference, falling back to the active channel.
 */
export async function resolveOptionalSlackChannelRef(input: {
  field?: string;
  value?: string;
  defaultChannelId?: SlackChannelId;
  teamId: SlackTeamId;
}): Promise<ResolvedSlackChannelTarget> {
  if (input.value !== undefined) {
    return resolveSlackChannelRef({
      field: input.field ?? "channel_id",
      value: input.value,
      teamId: input.teamId,
    });
  }

  if (input.defaultChannelId) {
    return {
      channelId: input.defaultChannelId,
    };
  }

  throw new ToolInputError(
    "Provide `channel_id`, or use this tool in an active Slack channel context.",
  );
}
