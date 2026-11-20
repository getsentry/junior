import type { User } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb } from "@/chat/db";
import { listOwnedWatches } from "@/chat/events/owned-watches";
import { cancelWatch } from "@/chat/events/store";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { throwApiError } from "../http";
import { type ConversationWatchesReport } from "../schema/watch";
import { readConversationAccessFromSql } from "./access";

/**
 * Load the active Watches that one Conversation owns, or throw a standard API
 * not-found error. Viewers who cannot see private content get only the
 * resource type, event types, and times of each Watch.
 */
export async function requireConversationWatches(
  conversationId: string,
  options: { viewer?: User | undefined } = {},
): Promise<ConversationWatchesReport> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const [accessByConversation, owned] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], options.viewer),
    listOwnedWatches(conversationId),
  ]);
  const canExposePayload =
    accessByConversation.get(conversationId)?.canViewPrivateContent ?? false;

  const catalog = getEventCatalog();
  const watches = owned.map(({ childAgent, watch }) => {
    const url = canExposePayload
      ? catalog[watch.namespace]?.resourceUrl?.({
          identifier: watch.identifier,
          resourceType: watch.resourceType,
        })
      : undefined;
    return {
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
            ...(url ? { url } : undefined),
          }
        : { redacted: true as const }),
    };
  });

  return { conversationId, watches };
}

/**
 * Cancel one active Watch of one Conversation for a Participant, the same
 * people who can stop its Turn. Only the Conversation that created the Watch
 * cancels it, so a child agent's Watch is cancelled through the child.
 *
 * The agent gets no notice. Its next `listWatches` no longer shows the Watch.
 */
export async function cancelConversationWatchForViewer(
  viewer: User,
  conversationId: string,
  watchId: string,
): Promise<void> {
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
  if (!access?.canViewPrivateContent) {
    throwApiError(404, "Conversation not found.");
  }
  if (!access.isParticipant) {
    throwApiError(403, "Only conversation participants can cancel a Watch.");
  }
  const watch = await cancelWatch({ conversationId, id: watchId });
  if (!watch) throwApiError(404, "Watch not found.");
  if (watch.status === "completed") {
    throwApiError(409, "Watch already completed.");
  }
}
