import {
  actorSchema,
  sourceSchema,
  sourceVisibilitySchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const MEMORY_KINDS = ["preference", "procedure", "knowledge"] as const;

export const MEMORY_SCOPES = ["private", "public"] as const;
export const MEMORY_SUBJECT_TYPES = [
  "user",
  "conversation",
  "general",
] as const;
// Durable attribution follows Source kind, including dashboard roots.
export const MEMORY_SOURCE_PLATFORMS = ["slack", "local", "web"] as const;
export const MEMORY_EMBEDDING_METRICS = ["cosine"] as const;
/** Things that can happen to a stored memory and feed future recall weights. */
export const MEMORY_SIGNALS = ["duplicate"] as const;
/**
 * Vector sizes the embeddings table can store, so one table can hold vectors
 * from an old and a new model while a model change is in progress. Only 1024
 * has an HNSW index.
 */
export const MEMORY_EMBEDDING_DIMENSIONS = [1024, 1536] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemorySubjectType = (typeof MEMORY_SUBJECT_TYPES)[number];
export type MemorySourcePlatform = (typeof MEMORY_SOURCE_PLATFORMS)[number];
export type MemoryEmbeddingMetric = (typeof MEMORY_EMBEDDING_METRICS)[number];
export type MemoryEmbeddingDimensions =
  (typeof MEMORY_EMBEDDING_DIMENSIONS)[number];
export type MemorySignal = (typeof MEMORY_SIGNALS)[number];

const nonEmptyStringSchema = z.string().min(1);

/** Host data used to set memory access, subject, and source. */
export const memoryRuntimeContextSchema = z
  .object({
    conversationId: nonEmptyStringSchema.optional(),
    locationId: nonEmptyStringSchema.optional(),
    actor: actorSchema.optional(),
    source: sourceSchema,
    /** Visibility of the Conversation. Child agents inherit their root's. */
    conversationVisibility: sourceVisibilitySchema,
    /** User linked to the active Actor. */
    userId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type MemoryRuntimeContext = z.output<typeof memoryRuntimeContextSchema>;
