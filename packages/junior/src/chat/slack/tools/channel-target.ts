import {
  resolvePublicChannelByName,
  type SlackPublicChannelSummary,
} from "@/chat/slack/channel";
import { parseSlackChannelId, type SlackChannelId } from "@/chat/slack/ids";
import { z } from "zod";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

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
 * Model-facing channel reference parameter.
 *
 * Accepts a Slack conversation id (`C123`) or a public channel name
 * (`#proj-foo` / `proj-foo`). Names are resolved internally at execution time.
 */
export function slackChannelRefParam(description: string) {
  return z.string().trim().min(1).max(80).describe(description);
}

/** Optional form of {@link slackChannelRefParam}. */
export function optionalSlackChannelRefParam(description: string) {
  return slackChannelRefParam(description).optional();
}

/**
 * Resolve a channel reference from a tool param value.
 *
 * Exact channel ids are parsed directly. Anything else is treated as a public
 * channel name (with or without a leading `#`) and resolved via Slack.
 */
export async function resolveSlackChannelRef(input: {
  field: string;
  value: string;
  nameResolver?: SlackChannelNameResolver;
}): Promise<ResolvedSlackChannelTarget> {
  const trimmed = input.value.trim();
  if (!trimmed) {
    throw new ToolInputError(
      `Invalid \`${input.field}\`. Provide a Slack channel id like \`C123\` or a public channel name like \`#proj-foo\`.`,
    );
  }

  const channelId = parseSlackChannelId(trimmed);
  if (channelId) {
    return {
      channelId,
      resolvedFromName: false,
    };
  }

  const resolver =
    input.nameResolver ??
    ({
      resolvePublicChannelByName,
    } satisfies SlackChannelNameResolver);
  const match = await resolver.resolvePublicChannelByName(trimmed);
  if (!match) {
    throw new ToolInputError(
      `No public Slack channel named \`${trimmed}\` was found. Use an exact public channel name or a channel id.`,
    );
  }

  return {
    channelId: match.id,
    ...(match.name ? { channelName: match.name } : {}),
    resolvedFromName: true,
  };
}

/**
 * Resolve an optional channel reference, falling back to the active channel.
 */
export async function resolveOptionalSlackChannelRef(input: {
  field?: string;
  value?: string;
  defaultChannelId?: SlackChannelId;
  nameResolver?: SlackChannelNameResolver;
}): Promise<ResolvedSlackChannelTarget> {
  if (input.value !== undefined) {
    return resolveSlackChannelRef({
      field: input.field ?? "channel_id",
      value: input.value,
      nameResolver: input.nameResolver,
    });
  }

  if (input.defaultChannelId) {
    return {
      channelId: input.defaultChannelId,
      resolvedFromName: false,
    };
  }

  throw new ToolInputError(
    "Provide `channel_id` (channel id or public channel name), or use this tool in an active Slack channel context.",
  );
}
