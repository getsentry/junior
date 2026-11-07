import * as z from "zod";
import { locationSchema } from "./location";

/**
 * What a child Conversation copies from its parent when it is created. Its
 * Runs read these values and never read them from a parent again.
 */
export const childSpawnSchema = z.strictObject({
  /** The root's Location, for provider defaults. The child does not post there. */
  location: locationSchema,
});

/** What a child Conversation saves when it is created. */
export type ChildSpawn = z.output<typeof childSpawnSchema>;
