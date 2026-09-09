import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationBriefs, juniorConversations } from "@/db/schema";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { conversationBriefSchema, type ConversationBrief } from "./brief";

export type ConversationBriefVersion = {
  conversationId: string;
  version: number;
  turnId: string;
  throughSeq: number;
  content: ConversationBrief;
  searchText: string;
  modelId: string;
  costUsd?: number;
  createdAt: Date;
};

type ConversationBriefRow = typeof juniorConversationBriefs.$inferSelect;

function briefVersionFromRow(
  row: ConversationBriefRow,
): ConversationBriefVersion {
  return {
    conversationId: row.conversationId,
    version: row.version,
    turnId: row.turnId,
    throughSeq: row.throughSeq,
    content: conversationBriefSchema.parse(row.content),
    searchText: row.searchText,
    modelId: row.modelId,
    ...(row.costUsd !== null ? { costUsd: row.costUsd } : undefined),
    createdAt: row.createdAt,
  };
}

/** Append the next Brief version, or return the row for an existing Turn. */
export async function appendConversationBrief(
  db: JuniorDatabase,
  input: {
    conversationId: string;
    turnId: string;
    throughSeq: number;
    content: ConversationBrief;
    searchText: string;
    modelId: string;
    costUsd?: number;
  },
): Promise<{ inserted: boolean; value: ConversationBriefVersion }> {
  return await db.transaction(async (tx) => {
    const conversations = await tx
      .select({
        conversationId: juniorConversations.conversationId,
        transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, input.conversationId))
      .for("update");
    const conversation = conversations[0];
    if (!conversation) {
      throw new Error(`Conversation ${input.conversationId} is unavailable`);
    }
    if (conversation.transcriptPurgedAt) {
      const root = await resolveRootVisibility(
        { db: () => tx },
        input.conversationId,
      );
      if (root.visibility !== "public") {
        throw new Error(
          `Cannot append a Brief to purged non-public Conversation ${input.conversationId}`,
        );
      }
    }

    const existing = await tx
      .select()
      .from(juniorConversationBriefs)
      .where(
        and(
          eq(juniorConversationBriefs.conversationId, input.conversationId),
          eq(juniorConversationBriefs.turnId, input.turnId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { inserted: false, value: briefVersionFromRow(existing[0]) };
    }

    const versions = await tx
      .select({ version: max(juniorConversationBriefs.version) })
      .from(juniorConversationBriefs)
      .where(eq(juniorConversationBriefs.conversationId, input.conversationId));
    const version = (versions[0]?.version ?? 0) + 1;
    const inserted = await tx
      .insert(juniorConversationBriefs)
      .values({
        conversationId: input.conversationId,
        version,
        turnId: input.turnId,
        throughSeq: input.throughSeq,
        content: conversationBriefSchema.parse(input.content),
        searchText: input.searchText,
        modelId: input.modelId,
        costUsd: input.costUsd ?? null,
      })
      .onConflictDoNothing({
        target: [
          juniorConversationBriefs.conversationId,
          juniorConversationBriefs.turnId,
        ],
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("Brief insert conflicted after the Turn check");
    }
    return { inserted: true, value: briefVersionFromRow(row) };
  });
}

/** Read the Brief version produced for one completed Turn. */
export async function readConversationBriefForTurn(
  db: JuniorDatabase,
  conversationId: string,
  turnId: string,
): Promise<ConversationBriefVersion | undefined> {
  const rows = await db
    .select()
    .from(juniorConversationBriefs)
    .where(
      and(
        eq(juniorConversationBriefs.conversationId, conversationId),
        eq(juniorConversationBriefs.turnId, turnId),
      ),
    )
    .limit(1);
  return rows[0] ? briefVersionFromRow(rows[0]) : undefined;
}

/** Read the latest Brief version for one Conversation. */
export async function readLatestConversationBrief(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ConversationBriefVersion | undefined> {
  const rows = await db
    .select()
    .from(juniorConversationBriefs)
    .where(eq(juniorConversationBriefs.conversationId, conversationId))
    .orderBy(desc(juniorConversationBriefs.version))
    .limit(1);
  return rows[0] ? briefVersionFromRow(rows[0]) : undefined;
}

/** Read each Conversation's latest Brief version. */
export async function readLatestConversationBriefs(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationBriefVersion>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([juniorConversationBriefs.conversationId])
    .from(juniorConversationBriefs)
    .where(
      inArray(juniorConversationBriefs.conversationId, [...conversationIds]),
    )
    .orderBy(
      juniorConversationBriefs.conversationId,
      desc(juniorConversationBriefs.version),
    );
  return new Map(
    rows.map((row) => [row.conversationId, briefVersionFromRow(row)]),
  );
}

/** Delete all Brief versions for the selected Conversations. */
export async function deleteConversationBriefs(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<void> {
  if (conversationIds.length === 0) return;
  await db
    .delete(juniorConversationBriefs)
    .where(
      inArray(juniorConversationBriefs.conversationId, [...conversationIds]),
    );
}
