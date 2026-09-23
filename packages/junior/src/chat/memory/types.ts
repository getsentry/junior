import { actorSchema, sourceSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  MEMORY_EMBEDDING_METRICS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
} from "@/db/schema/memory";

export {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_METRICS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_PLATFORMS,
  MEMORY_SUBJECT_TYPES,
} from "@/db/schema/memory";

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemorySubjectType = (typeof MEMORY_SUBJECT_TYPES)[number];
export type MemorySourcePlatform = (typeof MEMORY_SOURCE_PLATFORMS)[number];
export type MemoryEmbeddingMetric = (typeof MEMORY_EMBEDDING_METRICS)[number];

const nonEmptyStringSchema = z.string().min(1);

/** Host data used to set memory access, subject, and source. */
export const memoryRuntimeContextSchema = z
  .object({
    conversationId: nonEmptyStringSchema.optional(),
    locationId: nonEmptyStringSchema.optional(),
    actor: actorSchema.optional(),
    source: sourceSchema,
    /** User linked to the active Actor. */
    userId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type MemoryRuntimeContext = z.output<typeof memoryRuntimeContextSchema>;
