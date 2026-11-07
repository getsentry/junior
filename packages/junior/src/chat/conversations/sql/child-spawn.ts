import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Location } from "@/chat/conversations/location";
import { childVisibility } from "@/chat/conversations/spawn";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";
import { nextDetailVersion } from "./detail-version";

const spawnRoot = alias(juniorConversations, "spawn_root");

/**
 * Run a write that can change a Destination's visibility. When the value that
 * children save changes, the children of each root on that Destination save
 * the new value in the same transaction.
 */
export async function saveVisibilityChangeOnChildren(
  executor: JuniorSqlDatabase,
  key: {
    provider: string;
    providerDestinationId: string;
    providerTenantId: string;
  },
  write: () => Promise<
    { id: string; visibility: JuniorDestinationVisibility } | undefined
  >,
): Promise<string | undefined> {
  return await executor.transaction(async () => {
    const [before] = await executor
      .db()
      .select({ visibility: juniorDestinations.visibility })
      .from(juniorDestinations)
      .where(
        and(
          eq(juniorDestinations.provider, key.provider),
          eq(juniorDestinations.providerTenantId, key.providerTenantId),
          eq(
            juniorDestinations.providerDestinationId,
            key.providerDestinationId,
          ),
        ),
      )
      .for("update");
    const row = await write();
    if (
      row &&
      before &&
      childVisibility(before.visibility) !== childVisibility(row.visibility)
    ) {
      const roots = executor
        .db()
        .select({ id: spawnRoot.conversationId })
        .from(spawnRoot)
        .where(
          and(
            eq(spawnRoot.destinationId, row.id),
            isNull(spawnRoot.parentConversationId),
          ),
        );
      await executor
        .db()
        .update(juniorConversations)
        .set({
          spawn: sql`${juniorConversations.spawn} || jsonb_build_object('visibility', ${childVisibility(row.visibility)}::text)`,
          detailVersion: nextDetailVersion,
        })
        .where(
          and(
            inArray(juniorConversations.rootConversationId, roots),
            isNotNull(juniorConversations.parentConversationId),
            isNotNull(juniorConversations.spawn),
          ),
        );
    }
    return row?.id;
  });
}

/**
 * Save a root's new Location and the visibility of its Destination on all of
 * its children. Call it in the transaction that changed the root.
 */
export async function saveRootLocationOnChildren(
  executor: Pick<JuniorSqlDatabase, "db">,
  rootConversationId: string,
  location: Location,
): Promise<void> {
  await executor
    .db()
    .update(juniorConversations)
    .set({
      // The Location id is the root's Destination. Matches childVisibility.
      spawn: sql`jsonb_build_object(
        'location', ${JSON.stringify(location)}::jsonb,
        'visibility', case when (
          select ${juniorDestinations.visibility} from ${juniorDestinations}
          where ${juniorDestinations.id} = ${location.id}
        ) = 'public' then 'public' else 'private' end
      )`,
      detailVersion: nextDetailVersion,
    })
    .where(
      and(
        eq(juniorConversations.rootConversationId, rootConversationId),
        isNotNull(juniorConversations.parentConversationId),
      ),
    );
}
