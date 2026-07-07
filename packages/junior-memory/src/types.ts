import {
  localActorSchema,
  localSourceSchema,
  platformSchema,
  slackActorSchema,
  slackSourceSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const MEMORY_KINDS = ["preference", "procedure", "knowledge"] as const;

export const MEMORY_SCOPES = ["personal", "conversation"] as const;
export const MEMORY_SUBJECT_TYPES = [
  "user",
  "conversation",
  "general",
] as const;
export const MEMORY_SOURCE_PLATFORMS = [
  "slack",
  "local",
] as const satisfies readonly z.output<typeof platformSchema>[];
export const MEMORY_EMBEDDING_METRICS = ["cosine"] as const;
export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemorySubjectType = (typeof MEMORY_SUBJECT_TYPES)[number];
export type MemorySourcePlatform = (typeof MEMORY_SOURCE_PLATFORMS)[number];
export type MemoryEmbeddingMetric = (typeof MEMORY_EMBEDDING_METRICS)[number];

const nonEmptyStringSchema = z.string().min(1);

/** Runtime-owned memory invocation fields used for scope and source authority. */
export const slackMemoryRuntimeContextSchema = z
  .object({
    conversationId: nonEmptyStringSchema.optional(),
    actor: slackActorSchema.optional(),
    source: slackSourceSchema,
  })
  .strict();

/** Runtime-owned local memory invocation fields used for scope and source authority. */
export const localMemoryRuntimeContextSchema = z
  .object({
    conversationId: nonEmptyStringSchema.optional(),
    actor: localActorSchema.optional(),
    source: localSourceSchema,
  })
  .strict();

/** Runtime-owned memory invocation fields accepted by memory store operations. */
export const memoryRuntimeContextSchema = z.union([
  slackMemoryRuntimeContextSchema,
  localMemoryRuntimeContextSchema,
]);

export type MemoryRuntimeContext = z.output<typeof memoryRuntimeContextSchema>;
