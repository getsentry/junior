import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationAnnotations } from "@/db/schema";

// Exact key, or a nested child that continues with "#". Avoids sibling key
// collisions and partial nested-id prefixes.
function annotationKeyMatches(key: string): SQL {
  const annotation = key.toLowerCase();
  return sql`(
    lower(${juniorConversationAnnotations.key}) = ${annotation}
    or starts_with(
      lower(${juniorConversationAnnotations.key}),
      ${`${annotation}#`}
    )
  )`;
}

/**
 * Match Conversations that have an Annotation with `key`, or a nested child
 * key that continues with `#`. Matching ignores case.
 */
export function hasAnnotationKey(
  conversationId: AnyPgColumn,
  key: string,
): SQL {
  return sql`exists (
    select 1
    from ${juniorConversationAnnotations}
    where ${and(
      eq(juniorConversationAnnotations.conversationId, conversationId),
      annotationKeyMatches(key),
    )}
  )`;
}

/** Return the IDs in `conversationIds` that have an Annotation with `key`. */
export async function conversationIdsWithAnnotation(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  key: string,
): Promise<Set<string>> {
  if (conversationIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectDistinct({
      conversationId: juniorConversationAnnotations.conversationId,
    })
    .from(juniorConversationAnnotations)
    .where(
      and(
        inArray(juniorConversationAnnotations.conversationId, [
          ...conversationIds,
        ]),
        annotationKeyMatches(key),
      ),
    );
  return new Set(rows.map((row) => row.conversationId));
}
