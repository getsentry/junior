/**
 * SQL operations over personal memories owned by one authenticated viewer.
 *
 * A viewer may resolve to several runtime actors. This store combines their
 * personal scopes without treating one actor as the canonical identity.
 */
import { and, asc, desc, eq, gt, ilike, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import { deriveMemoryScope, type ResolvedMemoryScope } from "./scope";
import {
  activeVisiblePredicate,
  archiveExpiredMemoryBatch,
  parseMemoryRow,
  type MemoryDb,
  type MemoryRecord,
} from "./store";
import type { MemoryRuntimeContext } from "./types";

const nonEmptyStringSchema = z.string().min(1);
const personalMemoryCursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: nonEmptyStringSchema,
  })
  .strict();
const personalMemoryPageInputSchema = z
  .object({
    cursor: personalMemoryCursorSchema.optional(),
    limit: z.number().int().min(1).max(50),
    query: z.string().max(200).optional(),
  })
  .strict();

export type PersonalMemoryCursor = z.output<typeof personalMemoryCursorSchema>;

export type PersonalMemoryPageInput = z.output<
  typeof personalMemoryPageInputSchema
>;

export interface PersonalMemoryPage {
  memories: MemoryRecord[];
  nextCursor?: PersonalMemoryCursor;
}

/** Expected failure when a viewer does not own the requested memory. */
export class PersonalMemoryNotFoundError extends Error {
  constructor() {
    super("Memory was not found for the authenticated viewer.");
    this.name = "PersonalMemoryNotFoundError";
  }
}

/** Viewer-scoped personal memory operations shared by dashboard and REST. */
export interface PersonalMemoryCollection {
  /** Archive one exact personal memory owned by a linked actor. */
  archive(id: string): Promise<MemoryRecord>;
  /** Read one exact personal memory owned by a linked actor. */
  get(id: string): Promise<MemoryRecord>;
  /** List one stable page across every linked personal scope. */
  list(input: PersonalMemoryPageInput): Promise<PersonalMemoryPage>;
}

function personalScopes(
  runtimeContexts: MemoryRuntimeContext[],
): ResolvedMemoryScope[] {
  return [
    ...new Map(
      runtimeContexts.map((context) => {
        const scope = deriveMemoryScope(context, "personal");
        return [`${scope.scope}:${scope.scopeKey}`, scope] as const;
      }),
    ).values(),
  ];
}

function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_'-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  ];
}

/** Build storage operations for every personal scope linked to one viewer. */
export function createPersonalMemoryCollection(
  db: MemoryDb,
  runtimeContexts: MemoryRuntimeContext[],
  options: { now?: () => number } = {},
): PersonalMemoryCollection {
  const scopes = personalScopes(runtimeContexts);
  const getNowMs = () => options.now?.() ?? Date.now();

  return {
    async archive(id) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = getNowMs();
      const predicate = activeVisiblePredicate({ nowMs, scopes });
      if (!predicate) {
        throw new PersonalMemoryNotFoundError();
      }
      const updated = await db
        .update(juniorMemoryMemories)
        .set({
          archivedAtMs: nowMs,
          archiveReason: "user_removed",
        })
        .where(and(predicate, eq(juniorMemoryMemories.id, memoryId)))
        .returning();
      if (!updated[0]) {
        throw new PersonalMemoryNotFoundError();
      }
      await db
        .delete(juniorMemoryEmbeddings)
        .where(eq(juniorMemoryEmbeddings.memoryId, memoryId));
      return parseMemoryRow(updated[0]);
    },

    async get(id) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = getNowMs();
      const predicate = activeVisiblePredicate({ nowMs, scopes });
      if (!predicate) {
        throw new PersonalMemoryNotFoundError();
      }
      const rows = await db
        .select()
        .from(juniorMemoryMemories)
        .where(and(predicate, eq(juniorMemoryMemories.id, memoryId)))
        .limit(1);
      if (!rows[0]) {
        throw new PersonalMemoryNotFoundError();
      }
      return parseMemoryRow(rows[0]);
    },

    async list(input) {
      input = personalMemoryPageInputSchema.parse(input);
      const nowMs = getNowMs();
      await archiveExpiredMemoryBatch({ db, nowMs, scopes });
      const active = activeVisiblePredicate({ nowMs, scopes });
      if (!active) {
        return { memories: [] };
      }

      const cursor = input.cursor
        ? or(
            lt(juniorMemoryMemories.createdAtMs, input.cursor.createdAtMs),
            and(
              eq(juniorMemoryMemories.createdAtMs, input.cursor.createdAtMs),
              gt(juniorMemoryMemories.id, input.cursor.id),
            ),
          )
        : undefined;
      const terms = input.query ? searchTerms(input.query) : [];
      const search =
        input.query === undefined
          ? undefined
          : terms.length === 0
            ? sql`false`
            : or(
                ...terms.map((term) =>
                  ilike(juniorMemoryMemories.content, `%${term}%`),
                ),
              );
      const rows = await db
        .select()
        .from(juniorMemoryMemories)
        .where(and(active, cursor, search))
        .orderBy(
          desc(juniorMemoryMemories.createdAtMs),
          asc(juniorMemoryMemories.id),
        )
        .limit(input.limit + 1);
      const hasNextPage = rows.length > input.limit;
      const memories = rows.slice(0, input.limit).map(parseMemoryRow);
      const last = memories.at(-1);
      return {
        memories,
        ...(hasNextPage && last
          ? {
              nextCursor: {
                createdAtMs: last.createdAtMs,
                id: last.id,
              },
            }
          : {}),
      };
    },
  };
}
