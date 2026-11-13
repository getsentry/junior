import type { User } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { getConversationStore, getDb } from "@/chat/db";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import {
  BUSY,
  canContinueInSlack,
  continueConversationInSlack,
  type ContinueInSlackChannel,
} from "@/chat/slack/continue-in-slack";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { juniorDestinations } from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ContinueConversationInSlackBody,
  ContinueConversationInSlackResponse,
} from "../schema/conversation-continue-in-slack";
import { readConversationAccessFromSql } from "./access";

async function readSlackChannelLocation(
  locationId: string,
): Promise<ContinueInSlackChannel | undefined> {
  const [row] = await getDb()
    .select({
      channelId: juniorDestinations.providerDestinationId,
      displayName: juniorDestinations.displayName,
      teamId: juniorDestinations.providerTenantId,
    })
    .from(juniorDestinations)
    .where(
      and(
        eq(juniorDestinations.id, locationId),
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.kind, "channel"),
      ),
    );
  const channelId = parseSlackChannelId(row?.channelId);
  const teamId = parseSlackTeamId(row?.teamId);
  if (!row || !channelId || !teamId) return undefined;
  return {
    channelId,
    ...(row.displayName ? { channelName: row.displayName } : undefined),
    teamId,
  };
}

/** Move a participant's public dashboard Conversation to a new Slack thread. */
export async function continueConversationInSlackForViewer(
  viewer: User,
  conversationId: string,
  body: ContinueConversationInSlackBody,
): Promise<ContinueConversationInSlackResponse> {
  const conversation = await getConversationStore().get({ conversationId });
  const access = conversation
    ? (
        await readConversationAccessFromSql(getDb(), [conversationId], viewer)
      ).get(conversationId)
    : undefined;
  if (!conversation || !access?.canViewPrivateContent) {
    throwApiError(404, "Conversation not found.");
  }
  if (!access.isParticipant) {
    throwApiError(403, "Only conversation participants can move it to Slack.");
  }
  if (!canContinueInSlack(conversation, access)) {
    throwApiError(
      409,
      "Only a public dashboard conversation can move to Slack, once.",
    );
  }
  const channel = await readSlackChannelLocation(body.locationId);
  if (!channel) throwApiError(404, "Channel not found.");

  const result = await runWithSlackInstallation({
    adapter: getProductionSlackAdapter(),
    installation: { teamId: channel.teamId },
    task: () =>
      continueConversationInSlack({
        actorName: viewer.displayName ?? viewer.email,
        channel,
        conversation,
      }),
  });
  if (result.status === "busy") throwApiError(409, BUSY);
  if (result.status === "refused") throwApiError(409, result.message);
  return {
    conversationId,
    ...(result.channelName ? { channelName: result.channelName } : undefined),
    ...(result.locationUrl ? { locationUrl: result.locationUrl } : undefined),
  };
}
