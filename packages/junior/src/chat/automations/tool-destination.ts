/** Where a new or moved Automation delivers, for the Automation tools. */
import * as z from "zod";
import { getConversationStore } from "@/chat/db";
import { resolveBotSlackTeamId } from "@/chat/events/workspace";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import { getConversationInfo } from "@/chat/slack/channel";
import { checkSlackChannelReadAccess } from "@/chat/slack/tool-support/channel-access";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { Action } from "@/chat/guardian/guardian";
import type { AutomationDestination } from "./creator";
import {
  requireToolDestination,
  type AutomationToolCaller,
  type AutomationToolContext,
} from "./tool-access";

/** Model-facing Destination of a new or moved Automation. */
export const automationDestinationParam = slackChannelRefParam.describe(
  'Slack channel: "current_conversation" (this conversation\'s channel or DM) or a public channel you are in, by id, mention, or known name, only one the user named. Never a web conversation.',
);

/** A resolved Destination and the visibility that the Automation stores. */
interface ToolDestination {
  destination: AutomationDestination;
  visibility: "public" | "private" | undefined;
}

/**
 * Return the Slack workspace of a new Destination. A Conversation with no
 * Slack Location, such as a web Conversation, binds no workspace token, so
 * Slack calls use the single bot token. It can reach only that token's
 * workspace, and only for a caller with a linked Slack account there.
 */
async function requireDestinationTeamId(
  context: AutomationToolContext,
  caller: AutomationToolCaller,
): Promise<SlackTeamId> {
  if (context.destination) {
    const teamId = parseSlackTeamId(context.destination.teamId);
    if (!teamId) {
      throw new ToolInputError(
        'The Slack workspace of this Conversation is unknown. Set destination to "current_conversation", or ask from the Slack channel where the automation should deliver.',
      );
    }
    return teamId;
  }
  const teamId = parseSlackTeamId(await resolveBotSlackTeamId());
  if (!teamId) {
    throw new ToolInputError(
      "No Slack workspace can be chosen from this conversation. Ask from the Slack channel where the automation should deliver.",
    );
  }
  const linked = caller.viewer.identities.some(
    (identity) =>
      identity.provider === "slack" && identity.providerTenantId === teamId,
  );
  if (!linked) {
    throw new ToolInputError(
      "An automation delivers to Slack, and your account has no linked Slack account in this workspace. Link Slack, or ask from the Slack channel where it should deliver.",
    );
  }
  return teamId;
}

/**
 * Resolve where a new or moved Automation delivers. "current_conversation"
 * is the channel or DM of this Conversation. A channel reference must name a
 * public Slack channel that Junior is already in. Junior does not join a
 * channel to deliver an Automation there.
 * A private channel or DM can be a Destination only from there, so a web
 * Conversation can name only a public channel.
 */
export async function resolveToolDestination(
  context: AutomationToolContext,
  caller: AutomationToolCaller,
  value: z.output<typeof automationDestinationParam>,
): Promise<ToolDestination> {
  if (value === "current_conversation") {
    return {
      destination: requireToolDestination(context),
      visibility: context.visibility,
    };
  }
  const teamId = await requireDestinationTeamId(context, caller);
  const { channelId, channelName } = await resolveSlackChannelRef({
    field: "destination",
    value,
    teamId,
  });
  const here = context.destination;
  if (here && channelId === here.channelId) {
    return { destination: here, visibility: context.visibility };
  }
  const access = await checkSlackChannelReadAccess({
    currentChannelIds: [],
    targetChannelId: channelId,
    teamId,
  });
  if (!access.allowed) {
    throw new ToolInputError(
      access.reason === "private"
        ? "Only a public channel can be named as a destination. For a private channel or DM, ask from there."
        : access.error,
    );
  }
  const name = access.channelName ?? channelName;
  if (access.isMember !== true) {
    throw new ToolInputError(
      `You are not in ${name ? `#${name}` : "that channel"}. Someone must add you to the channel first.`,
    );
  }
  const destination: AutomationDestination = {
    platform: "slack",
    teamId,
    channelId,
  };
  // Automation access reads visibility from the Destination directory.
  await getConversationStore().recordDestinationVisibility({
    destination,
    ...(name ? { channelName: name } : undefined),
    visibility: "public",
  });
  return { destination, visibility: "public" };
}

/**
 * Where an Automation delivers and who can read it, for Guardian
 * (`audience`). A Slack channel or DM, also this Conversation's own, is
 * `world` when it is shared with another organization or Slack cannot
 * answer. A channel can be shared after the Automation is created.
 */
export async function automationDeliveryTarget(
  context: AutomationToolContext,
  value: z.output<typeof automationDestinationParam>,
): Promise<NonNullable<Action["target"]>> {
  const current = value === "current_conversation";
  if (current && !context.destination) {
    return { ref: "this Conversation", audience: "internal" };
  }
  const ref = current ? (context.destination?.channelId ?? value) : value;
  try {
    const channelId = current
      ? parseSlackChannelId(context.destination?.channelId)
      : await namedChannelId(context, value);
    if (!channelId) return { ref: `Slack channel ${ref}`, audience: "world" };
    const info = await getConversationInfo(channelId);
    return {
      ref: info.name
        ? `Slack channel #${info.name}`
        : `Slack channel ${channelId}`,
      audience: info.isExtShared ? "world" : "internal",
    };
  } catch {
    return { ref: `Slack channel ${ref}`, audience: "world" };
  }
}

async function namedChannelId(
  context: AutomationToolContext,
  value: string,
): Promise<SlackChannelId | undefined> {
  const teamId =
    parseSlackTeamId(context.destination?.teamId) ??
    parseSlackTeamId(await resolveBotSlackTeamId());
  if (!teamId) return undefined;
  const { channelId } = await resolveSlackChannelRef({
    field: "destination",
    value,
    teamId,
  });
  return channelId;
}
