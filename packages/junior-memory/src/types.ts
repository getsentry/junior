import {
  actorSchema,
  identitySchema,
  sourceSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const MEMORY_KINDS = ["preference", "procedure", "knowledge"] as const;

export const MEMORY_SCOPES = ["personal", "conversation"] as const;
export const MEMORY_SUBJECT_TYPES = [
  "user",
  "conversation",
  "general",
] as const;
// Durable attribution follows Source platform, including dashboard/web roots.
export const MEMORY_SOURCE_PLATFORMS = ["slack", "local", "web"] as const;
export const MEMORY_EMBEDDING_METRICS = ["cosine"] as const;
export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemorySubjectType = (typeof MEMORY_SUBJECT_TYPES)[number];
export type MemorySourcePlatform = (typeof MEMORY_SOURCE_PLATFORMS)[number];
export type MemoryEmbeddingMetric = (typeof MEMORY_EMBEDDING_METRICS)[number];

const nonEmptyStringSchema = z.string().min(1);

/** Runtime-owned memory invocation fields used for scope and source authority. */
export const memoryRuntimeContextSchema = z
  .object({
    conversationId: nonEmptyStringSchema.optional(),
    actor: actorSchema.optional(),
    // Linked identities authorize cross-surface public/personal read scopes.
    // Writes still use only actor + source authority.
    identities: z.array(identitySchema).max(100).optional(),
    source: sourceSchema,
  })
  .strict();

export type MemoryRuntimeContext = z.output<typeof memoryRuntimeContextSchema>;
