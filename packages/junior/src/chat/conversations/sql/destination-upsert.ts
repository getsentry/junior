import { randomUUID } from "node:crypto";
import type { Destination } from "@sentry/junior-plugin-api";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import type { JuniorDestinationKind } from "@/db/schema/destination-kind";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";
import { nextDetailVersion } from "./detail-version";

/** One Destination row to insert or refresh. */
export interface DestinationUpsert {
  displayName?: string;
  kind: JuniorDestinationKind;
  metadata?: Record<string, unknown>;
  provider: string;
  providerDestinationId: string;
  providerTenantId?: string | undefined;
  refreshVisibility: boolean;
  visibility: JuniorDestinationVisibility;
}

function localWorkspaceFromConversationId(
  conversationId: string,
): string | undefined {
  const match = /^local:([^:]+):/.exec(conversationId);
  return match?.[1];
}

/** Build the Destination row of a Conversation's Destination, if it has one. */
export function destinationUpsertFromDestination(args: {
  channelName?: string | undefined;
  conversationId?: string;
  destination: Destination | undefined;
  /** Confirmed destination visibility; omit when unavailable. */
  visibility?: ConversationPrivacy;
}): DestinationUpsert | undefined {
  const { destination } = args;
  if (!destination) {
    return undefined;
  }
  if (destination.platform === "slack") {
    const channelId = destination.channelId;
    const channelKind = channelId.startsWith("D")
      ? "dm"
      : channelId.startsWith("G")
        ? "group"
        : "channel";
    return {
      kind: channelKind,
      provider: "slack",
      providerTenantId: destination.teamId,
      providerDestinationId: channelId,
      refreshVisibility: args.visibility !== undefined,
      visibility: args.visibility ?? "unknown",
      ...(args.channelName ? { displayName: args.channelName } : undefined),
      metadata: { platform: "slack" },
    };
  }
  return {
    kind: "local_conversation",
    provider: "local",
    providerTenantId:
      localWorkspaceFromConversationId(destination.conversationId) ??
      localWorkspaceFromConversationId(args.conversationId ?? ""),
    providerDestinationId: destination.conversationId,
    // Match Slack: only refresh when a live visibility signal is present so
    // execution-metadata writes cannot clobber public dashboard roots.
    refreshVisibility: args.visibility !== undefined,
    visibility: args.visibility ?? "direct",
    metadata: { platform: "local" },
  };
}

/**
 * Insert or refresh a Destination row. A live visibility signal also moves
 * the roots at that Destination to the new value, so a Slack channel that
 * becomes private makes its Conversations private at once.
 */
export async function upsertDestination(
  executor: JuniorSqlDatabase,
  destination: DestinationUpsert | undefined,
  nowMs: number,
): Promise<{ id: string; visibility: ConversationPrivacy } | undefined> {
  if (!destination) {
    return undefined;
  }
  const visibilityUpdate = destination.refreshVisibility
    ? sql`excluded.visibility`
    : juniorDestinations.visibility;
  // Lock the stored row before a refresh, so the roots move only when the
  // value changes, not on every message in the channel.
  const before = destination.refreshVisibility
    ? (
        await executor
          .db()
          .select({ visibility: juniorDestinations.visibility })
          .from(juniorDestinations)
          .where(
            and(
              eq(juniorDestinations.provider, destination.provider),
              eq(
                juniorDestinations.providerTenantId,
                destination.providerTenantId ?? "",
              ),
              eq(
                juniorDestinations.providerDestinationId,
                destination.providerDestinationId,
              ),
            ),
          )
          .for("update")
      )[0]
    : undefined;
  const rows = await executor
    .db()
    .insert(juniorDestinations)
    .values({
      id: randomUUID(),
      provider: destination.provider,
      providerTenantId: destination.providerTenantId ?? "",
      providerDestinationId: destination.providerDestinationId,
      kind: destination.kind,
      parentDestinationId: null,
      displayName: destination.displayName ?? null,
      visibility: destination.visibility,
      metadata: destination.metadata ?? null,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .onConflictDoUpdate({
      target: [
        juniorDestinations.provider,
        juniorDestinations.providerTenantId,
        juniorDestinations.providerDestinationId,
      ],
      set: {
        kind: sql`excluded.kind`,
        displayName: sql`coalesce(excluded.display_name, ${juniorDestinations.displayName})`,
        // Signal-less writes remain unknown and must not clobber an existing
        // public/private value. Live source signals refresh this field so
        // converted channels converge on the next message.
        visibility: visibilityUpdate,
        metadata: sql`coalesce(excluded.metadata_json, ${juniorDestinations.metadata})`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({
      id: juniorDestinations.id,
      visibility: juniorDestinations.visibility,
    });
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  const visibility = row.visibility === "public" ? "public" : "private";
  if (
    before &&
    (before.visibility === "public") !== (visibility === "public")
  ) {
    await executor
      .db()
      .update(juniorConversations)
      .set({ visibility, detailVersion: nextDetailVersion })
      .where(
        and(
          eq(juniorConversations.destinationId, row.id),
          isNull(juniorConversations.parentConversationId),
        ),
      );
  }
  return { id: row.id, visibility };
}
