import { z } from "zod";
import { memoryRuntimeContextSchema } from "./types";

const memoryTargetSchema = z.enum(["requester", "conversation"]);
const createMemoryRequestSchema = z
  .object({
    content: z.string().min(1),
    expiresAtMs: z.number().finite().optional(),
    runtimeContext: memoryRuntimeContextSchema,
  })
  .strict();

const memoryReviewSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("store"),
      target: memoryTargetSchema,
      content: z.string().min(1),
      expiresAtMs: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type MemoryTarget = z.output<typeof memoryTargetSchema>;

export type MemoryReview = z.output<typeof memoryReviewSchema>;

export type CreateMemoryRequest = z.output<typeof createMemoryRequestSchema>;

export interface MemoryAgent {
  reviewCreateRequest(
    request: CreateMemoryRequest,
  ): Promise<MemoryReview> | MemoryReview;
}

/** Create the memory-owned agent that reviews candidates before storage. */
export function createMemoryAgent(): MemoryAgent {
  return {
    reviewCreateRequest() {
      return {
        decision: "reject",
        reason: "memory agent unavailable",
      };
    },
  };
}

/** Parse the structured decision returned by the memory agent. */
export function parseMemoryReview(result: unknown): MemoryReview {
  return memoryReviewSchema.parse(result);
}

/** Parse the structured input sent to the memory agent. */
export function parseCreateMemoryRequest(
  request: unknown,
): CreateMemoryRequest {
  return createMemoryRequestSchema.parse(request);
}
