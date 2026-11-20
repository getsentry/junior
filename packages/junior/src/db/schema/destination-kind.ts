import * as z from "zod";

// Kept apart from the Drizzle table so the browser bundle can use the schema
// without drizzle-orm.
export const juniorDestinationKindSchema = z.enum([
  "channel",
  "dm",
  "group",
  "local_conversation",
  "thread",
  "web_session",
]);

export type JuniorDestinationKind = z.infer<typeof juniorDestinationKindSchema>;
