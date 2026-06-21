import { z } from "zod";
import type { MemoryRuntimeContext } from "./types";

const memoryAdjudicationTargetSchema = z.enum(["requester", "conversation"]);

const memoryAdjudicationResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("allow"),
      target: memoryAdjudicationTargetSchema,
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

export type MemoryAdjudicationTarget = z.output<
  typeof memoryAdjudicationTargetSchema
>;

export type MemoryAdjudicationResult = z.output<
  typeof memoryAdjudicationResultSchema
>;

export interface MemoryCreateCandidate {
  content: string;
  expiresAtMs?: number;
  runtimeContext: MemoryRuntimeContext;
}

export interface MemoryAdjudicator {
  adjudicateCreateMemory(
    candidate: MemoryCreateCandidate,
  ): Promise<MemoryAdjudicationResult> | MemoryAdjudicationResult;
}

/** Parse the structured policy decision returned by a memory adjudicator. */
export function parseMemoryAdjudicationResult(
  result: unknown,
): MemoryAdjudicationResult {
  return memoryAdjudicationResultSchema.parse(result);
}
