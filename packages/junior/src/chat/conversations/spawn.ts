import * as z from "zod";
import { locationSchema } from "./location";

/**
 * What a child Conversation copies from its parent when it is created. Its
 * Runs read these values and never read them from a parent again.
 */
export const childSpawnSchema = z.object({
  /** Parent links above the child. A child of a root has depth 1. */
  depth: z.number().int().positive(),
  /** The root Location. Its provider defaults apply. It grants no delivery. */
  location: locationSchema.optional(),
  /** Visibility of the root at spawn. Missing or unknown visibility is private. */
  visibility: z.enum(["public", "private"]),
});

/** Parent facts that a child Conversation stores at spawn. */
export type ChildSpawn = z.output<typeof childSpawnSchema>;
