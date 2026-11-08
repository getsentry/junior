import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationAnnotations,
  juniorConversations,
} from "@/db/schema";

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

const ANNOTATED_ALIAS = "annotated_conversations";

/**
 * Match root Conversations where any Conversation in the tree has an
 * Annotation with `key`. Tools write the Annotation on the Conversation that
 * ran them, which can be a child agent.
 */
export function treeHasAnnotationKey(
  rootConversationId: AnyPgColumn,
  key: string,
): SQL {
  // An alias, so the outer query's Conversation columns are not shadowed.
  const annotated = alias(juniorConversations, ANNOTATED_ALIAS);
  return sql`exists (
    select 1
    from ${juniorConversationAnnotations}
    inner join ${juniorConversations} as ${sql.identifier(ANNOTATED_ALIAS)}
      on ${annotated.conversationId} = ${juniorConversationAnnotations.conversationId}
    where ${and(
      eq(annotated.rootConversationId, rootConversationId),
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
