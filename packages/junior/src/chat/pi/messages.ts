import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as z from "zod";

/** Permissive schema for durable Pi SDK messages whose content shape may evolve. */
export const piMessageSchema = z
  .object({
    role: z.string(),
  })
  .passthrough()
  // Asserting to an intersection is valid for every Pi message type, so this
  // boundary cast needs no `@ts-expect-error` when Pi changes its types.
  .transform((value): AgentMessage => value as typeof value & AgentMessage);

/** Durable Pi transcript message stored across turns. */
export type PiMessage = z.output<typeof piMessageSchema>;

/** Reporting transcript entries only render messages with structured content parts. */
export const piContentMessageSchema = z
  .object({
    content: z.array(z.unknown()),
    role: z.string().min(1),
  })
  .passthrough()
  .transform((value): PiMessage => value as typeof value & PiMessage);
