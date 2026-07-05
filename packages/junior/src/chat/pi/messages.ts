import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { z } from "zod";

/** Permissive schema for durable Pi SDK messages whose content shape may evolve. */
export const piMessageSchema = z
  .object({
    role: z.string(),
  })
  .passthrough()
  .transform((value) => value as unknown as AgentMessage);

/** Durable Pi transcript message stored across turns. */
export type PiMessage = z.output<typeof piMessageSchema>;

/** Reporting transcript entries only render messages with structured content parts. */
export const piContentMessageSchema = z
  .object({
    content: z.array(z.unknown()),
    role: z.string().min(1),
  })
  .passthrough()
  .transform((value) => value as unknown as PiMessage);
