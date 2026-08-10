import {
  resolvePublicChannelByName,
  type SlackPublicChannelSummary,
} from "@/chat/slack/channel";
import {
  parseRequiredSlackChannelIdParam,
  slackChannelIdParam,
} from "@/chat/slack/id-param";
import type { SlackChannelId } from "@/chat/slack/ids";
import { z } from "zod";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Model-facing optional channel id parameter. */
export function optionalSlackChannelIdParam(description: string) {
  return slackChannelIdParam(description).optional();
}

/** Model-facing optional public channel name parameter (`#foo` or `foo`). */
export function optionalSlackChannelNameParam(description: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe(description)
    .optional();
}

export interface ResolvedSlackChannelTarget {
  channelId: SlackChannelId;
  channelName?: string;
  resolvedFromName: boolean;
}

export interface SlackChannelNameResolver {
  resolvePublicChannelByName(
    channelName: string,
  ): Promise<SlackPublicChannelSummary | undefined>;
}

/**
 * Resolve a channel target from an explicit id and/or public channel name.
 *
 * Prefer `channel_id` when both are present. Names may include a leading `#`.
 */
export async function resolveSlackChannelTarget(input: {
  channelId?: string;
  channelName?: string;
  defaultChannelId?: SlackChannelId;
  nameResolver?: SlackChannelNameResolver;
}): Promise<ResolvedSlackChannelTarget> {
  if (input.channelId !== undefined) {
    const parsed = parseRequiredSlackChannelIdParam(
      "channel_id",
      input.channelId,
    );
    if (!parsed.ok) {
      throw new ToolInputError(parsed.error);
    }
    return {
      channelId: parsed.value,
      resolvedFromName: false,
    };
  }

  if (input.channelName !== undefined) {
    const resolver =
      input.nameResolver ??
      ({
        resolvePublicChannelByName,
      } satisfies SlackChannelNameResolver);
    const match = await resolver.resolvePublicChannelByName(input.channelName);
    if (!match) {
      throw new ToolInputError(
        `No public Slack channel named \`${input.channelName.trim()}\` was found. Use an exact public channel name or a channel id.`,
      );
    }
    return {
      channelId: match.id,
      ...(match.name ? { channelName: match.name } : {}),
      resolvedFromName: true,
    };
  }

  if (input.defaultChannelId) {
    return {
      channelId: input.defaultChannelId,
      resolvedFromName: false,
    };
  }

  throw new ToolInputError(
    "Provide `channel_id` or `channel_name`, or use this tool in an active Slack channel context.",
  );
}
