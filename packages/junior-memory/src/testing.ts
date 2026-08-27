import { asc, eq, inArray } from "drizzle-orm";
import { createMemory } from "./create";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import type { MemoryDb } from "./memories";

/** Remove all memories and their embeddings from the test database. */
export async function clearAll(db: MemoryDb): Promise<void> {
  await db.delete(juniorMemoryEmbeddings);
  await db.delete(juniorMemoryMemories);
}

/** List memories learned from one Source, oldest first. */
export async function listBySource(db: MemoryDb, sourceKey: string) {
  return db
    .select({
      archivedAtMs: juniorMemoryMemories.archivedAtMs,
      content: juniorMemoryMemories.content,
      expiresAtMs: juniorMemoryMemories.expiresAtMs,
      id: juniorMemoryMemories.id,
      kind: juniorMemoryMemories.kind,
      scope: juniorMemoryMemories.scope,
      scopeKey: juniorMemoryMemories.scopeKey,
      subjectKey: juniorMemoryMemories.subjectKey,
      subjectType: juniorMemoryMemories.subjectType,
      supersededAtMs: juniorMemoryMemories.supersededAtMs,
      supersededById: juniorMemoryMemories.supersededById,
    })
    .from(juniorMemoryMemories)
    .where(eq(juniorMemoryMemories.sourceKey, sourceKey))
    .orderBy(
      asc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    );
}

/** Count embeddings for the given memory IDs. */
export async function countEmbeddings(
  db: MemoryDb,
  memoryIds: string[],
): Promise<number> {
  const rows = await db
    .select({ memoryId: juniorMemoryEmbeddings.memoryId })
    .from(juniorMemoryEmbeddings)
    .where(inArray(juniorMemoryEmbeddings.memoryId, memoryIds));
  return rows.length;
}

export { createMemory };
export type { MemoryDb };
