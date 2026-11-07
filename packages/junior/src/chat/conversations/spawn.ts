import * as z from "zod";
import { locationSchema } from "./location";

/**
 * What a child Conversation copies from its parent when it is created. Its
 * Runs read these values and never read them from a parent again.
 */
export const childSpawnSchema = z.object({
  /** Parent links above the child. A child of a root has depth 1. */
  depth: z.number().int().positive(),
  /** The root's Location, for provider defaults. The child does not post there. */
  location: locationSchema.optional(),
  /** Visibility of the root at spawn. Missing or unknown visibility is private. */
  visibility: z.enum(["public", "private"]),
});

/** What a child Conversation saves when it is created. */
export type ChildSpawn = z.output<typeof childSpawnSchema>;
