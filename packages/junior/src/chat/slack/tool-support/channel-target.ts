import {
  parseSlackChannelReferenceId,
  type SlackChannelId,
} from "@/chat/slack/ids";
import { z } from "zod";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export interface ResolvedSlackChannelTarget {
  channelId: SlackChannelId;
}

/** Model-facing Slack channel id parameter. */
export const slackChannelRefParam = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe(
    "Slack channel id (`C123`), mention (`<#C123>` / `<#C123|name>`), or Junior slack reference (`slack:C123`). Plain channel names are not accepted.",
  );

/**
 * Resolve a channel reference from a tool param value.
 *
 * Accept only forms that already carry a channel id. Do not scan the workspace
 * by public channel name.
 */
export function resolveSlackChannelRef(input: {
  field: string;
  value: string;
}): ResolvedSlackChannelTarget {
  const trimmed = input.value.trim();
  const channelId = parseSlackChannelReferenceId(trimmed);
  if (channelId) {
    return { channelId };
  }

  throw new ToolInputError(
    `Invalid \`${input.field}\`. Use a channel id (\`C123\`), a Slack mention (\`<#C123>\`), or a Junior slack reference (\`slack:C123\`). Plain channel names are not resolved; use a mention, id, link, or public search when you need to find the channel.`,
  );
}

/**
 * Resolve an optional channel reference, falling back to the active channel.
 */
export function resolveOptionalSlackChannelRef(input: {
  field?: string;
  value?: string;
  defaultChannelId?: SlackChannelId;
}): ResolvedSlackChannelTarget {
  if (input.value !== undefined) {
    return resolveSlackChannelRef({
      field: input.field ?? "channel_id",
      value: input.value,
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
