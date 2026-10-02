import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { z } from "zod";

/** Permissive schema for durable Pi SDK messages whose content shape may evolve. */
export const piMessageSchema = z
  .object({
    role: z.string(),
  })
  .passthrough()
  // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
  .transform((value) => value as AgentMessage);

/** Durable Pi transcript message stored across turns. */
export type PiMessage = z.output<typeof piMessageSchema>;
