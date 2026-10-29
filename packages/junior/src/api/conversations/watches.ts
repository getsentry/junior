import type { User } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb } from "@/chat/db";
import { listOwnedWatches } from "@/chat/events/owned-watches";
import { throwApiError } from "../http";
import {
  conversationWatchesReportSchema,
  type ConversationWatchesReport,
} from "../schema/watch";
import { readConversationAccessFromSql } from "./access";

/**
 * Load the active Watches that one Conversation owns, or throw a standard API
 * not-found error. Viewers who cannot see private content get only the
 * resource type, event types, and times of each Watch.
 */
export async function requireConversationWatches(
  conversationId: string,
  options: { viewer?: User } = {},
): Promise<ConversationWatchesReport> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const [accessByConversation, owned] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], options.viewer),
    listOwnedWatches(conversationId),
  ]);
  const canExposePayload =
    accessByConversation.get(conversationId)?.canViewPrivateContent ?? false;

  const watches = owned.map(({ childAgent, watch }) => ({
    ...(childAgent
      ? {
          childAgent: {
            conversationId: childAgent.conversationId,
            ...(canExposePayload && childAgent.name
              ? { name: childAgent.name }
              : undefined),
          },
        }
      : undefined),
    createdAt: new Date(watch.createdAtMs).toISOString(),
    events: watch.events,
    expiresAt: new Date(watch.expiresAtMs).toISOString(),
    ...(watch.firesAtMs !== undefined
      ? { firesAt: new Date(watch.firesAtMs).toISOString() }
      : undefined),
    id: watch.id,
    namespace: watch.namespace,
    resourceType: watch.resourceType,
    ...(canExposePayload
      ? {
          intent: watch.intent,
          label: watch.label,
          ...(watch.match ? { match: watch.match } : undefined),
        }
      : { redacted: true as const }),
  }));

  return conversationWatchesReportSchema.parse({ conversationId, watches });
}
