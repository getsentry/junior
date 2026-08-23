/** Memory row validation, access filters, and expired cleanup. */
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { z } from "zod";
import * as memorySqlSchema from "./db/schema";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import type { ResolvedMemoryScope } from "./scope";
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
} from "./types";

export type MemoryDb = PgDatabase<PgQueryResultHKT, typeof memorySqlSchema>;

const numberSchema = z.number().finite();
const optionalNumberSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.coerce.number().optional(),
);
const optionalStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);
const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().min(1).optional(),
);
const memoryContentSchema = z
  .string()
  .refine((content) => content.trim().length > 0, {
    message: "Memory content is required.",
  });
const memoryRowSchema = z
  .object({
    archivedAtMs: optionalNumberSchema,
    archiveReason: optionalStringSchema,
    content: memoryContentSchema,
    createdAtMs: z.coerce.number(),
    expiresAtMs: optionalNumberSchema,
    id: z.string().min(1),
    idempotencyKey: optionalStringSchema,
    locationId: optionalNonEmptyStringSchema,
    observedAtMs: z.coerce.number(),
    searchVector: z.string().optional(),
    scope: z.enum(MEMORY_SCOPES),
    scopeKey: z.string().min(1),
    sourceKey: z.string().min(1),
    sourcePlatform: z.enum(MEMORY_SOURCE_PLATFORMS),
    subjectKey: optionalNonEmptyStringSchema,
    subjectType: z.enum(MEMORY_SUBJECT_TYPES),
    supersededAtMs: optionalNumberSchema,
    supersededById: optionalStringSchema,
    kind: z.enum(MEMORY_KINDS),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.subjectType === "general") {
      if (row.subjectKey !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "General-subject memory rows must not have a subject key.",
          path: ["subjectKey"],
        });
      }
      return;
    }
    if (row.subjectKey === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "User and conversation memory rows require a subject key.",
        path: ["subjectKey"],
      });
    }
  });

const memorySchema = z
  .object({
    archivedAtMs: numberSchema.optional(),
    archiveReason: z.string().min(1).optional(),
    content: memoryContentSchema,
    createdAtMs: numberSchema,
    expiresAtMs: numberSchema.optional(),
    id: z.string().min(1),
    observedAtMs: numberSchema,
    scope: z.enum(MEMORY_SCOPES),
    subjectType: z.enum(MEMORY_SUBJECT_TYPES),
    supersededAtMs: numberSchema.optional(),
    supersededById: z.string().min(1).optional(),
    kind: z.enum(MEMORY_KINDS),
  })
  .strict();

export type Memory = z.output<typeof memorySchema>;

/** Parse one SQL row into the public memory projection. */
export function parseMemoryRow(row: unknown): Memory {
  const parsed = memoryRowSchema.parse(row);
  const memory: z.input<typeof memorySchema> = {
    id: parsed.id,
    scope: parsed.scope,
    kind: parsed.kind,
    subjectType: parsed.subjectType,
    content: parsed.content,
    observedAtMs: parsed.observedAtMs,
    createdAtMs: parsed.createdAtMs,
  };
  if (parsed.expiresAtMs !== undefined) memory.expiresAtMs = parsed.expiresAtMs;
  if (parsed.supersededAtMs !== undefined) {
    memory.supersededAtMs = parsed.supersededAtMs;
  }
  if (parsed.supersededById) memory.supersededById = parsed.supersededById;
  if (parsed.archivedAtMs !== undefined) {
    memory.archivedAtMs = parsed.archivedAtMs;
  }
  if (parsed.archiveReason) memory.archiveReason = parsed.archiveReason;
  return memorySchema.parse(memory);
}

function visibleScopePredicate(scopes: ResolvedMemoryScope[]): SQL | undefined {
  if (scopes.length === 0) {
    return undefined;
  }
  return or(
    ...scopes.map((scope) =>
      and(
        eq(juniorMemoryMemories.scope, scope.scope),
        eq(juniorMemoryMemories.scopeKey, scope.scopeKey),
      ),
    ),
  );
}

/** Build the active-row predicate for already-authorized memory scopes. */
export function activeVisiblePredicate(args: {
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): SQL | undefined {
  const scopePredicate = visibleScopePredicate(args.scopes);
  if (!scopePredicate) {
    return undefined;
  }
  return and(
    scopePredicate,
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
    ),
  );
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(200, Math.max(1, Math.floor(value)));
}

/** Archive a bounded batch of expired rows and remove their derived vectors. */
export async function archiveExpiredMemoryBatch(args: {
  db: MemoryDb;
  idempotencyKey?: string;
  limit?: number;
  nowMs: number;
  scopes: ResolvedMemoryScope[];
}): Promise<{ archivedCount: number }> {
  const scopePredicate = visibleScopePredicate(args.scopes);
  if (!scopePredicate) {
    return { archivedCount: 0 };
  }
  const predicates: SQL[] = [
    scopePredicate,
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    lte(juniorMemoryMemories.expiresAtMs, args.nowMs),
  ];
  if (args.idempotencyKey !== undefined) {
    predicates.push(
      eq(juniorMemoryMemories.idempotencyKey, args.idempotencyKey),
    );
  }

  const archivedIds = await args.db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: juniorMemoryMemories.id })
      .from(juniorMemoryMemories)
      .where(and(...predicates))
      .orderBy(
        asc(juniorMemoryMemories.expiresAtMs),
        asc(juniorMemoryMemories.id),
      )
      .limit(boundedLimit(args.limit, 100));
    const ids = expired.map((row) => row.id);
    if (ids.length === 0) {
      return [];
    }
    const archived = await tx
      .update(juniorMemoryMemories)
      .set({ archivedAtMs: args.nowMs, archiveReason: "expired" })
      .where(and(inArray(juniorMemoryMemories.id, ids), ...predicates))
      .returning({ id: juniorMemoryMemories.id });
    const idsToClean = archived.map((row) => row.id);
    if (idsToClean.length > 0) {
      await tx
        .delete(juniorMemoryEmbeddings)
        .where(inArray(juniorMemoryEmbeddings.memoryId, idsToClean));
    }
    return idsToClean;
  });
  return { archivedCount: archivedIds.length };
}
