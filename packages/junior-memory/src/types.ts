import {
  localRequesterSchema,
  localSourceSchema,
  platformSchema,
  slackRequesterSchema,
  slackSourceSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

export const MEMORY_TYPES = [
  "preference",
  "identity",
  "relationship",
  "knowledge",
  "context",
  "event",
  "task",
  "observation",
] as const;

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

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemorySubjectType = (typeof MEMORY_SUBJECT_TYPES)[number];
export type MemorySourcePlatform = (typeof MEMORY_SOURCE_PLATFORMS)[number];

const nonEmptyStringSchema = z.string().min(1);

/** Runtime-owned memory invocation fields used for scope and source authority. */
export const slackMemoryRuntimeContextSchema = z
  .object({
    conversationId: nonEmptyStringSchema.optional(),
    requester: slackRequesterSchema.optional(),
    source: slackSourceSchema,
  })
  .strict();

/** Runtime-owned local memory invocation fields used for scope and source authority. */
export const localMemoryRuntimeContextSchema = z
  .object({
    conversationId: nonEmptyStringSchema.optional(),
    requester: localRequesterSchema.optional(),
    source: localSourceSchema,
  })
  .strict();

/** Runtime-owned memory invocation fields accepted by memory store operations. */
export const memoryRuntimeContextSchema = z.union([
  slackMemoryRuntimeContextSchema,
  localMemoryRuntimeContextSchema,
]);

export type MemoryRuntimeContext = z.output<typeof memoryRuntimeContextSchema>;
