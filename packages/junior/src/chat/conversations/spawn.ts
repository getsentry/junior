import * as z from "zod";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { locationSchema } from "./location";
import type { Conversation } from "./store";

/**
 * What a child Conversation saves from its root. Its Runs read these values
 * and never read them from a parent. A change on the root writes them again.
 */
export const childSpawnSchema = z.strictObject({
  /** The root's Location, for provider defaults. The child does not post there. */
  location: locationSchema.optional(),
  /** The root's visibility. */
  visibility: z.enum(["public", "private"]),
});

/** What a child Conversation saves from its root. */
export type ChildSpawn = z.output<typeof childSpawnSchema>;

/** Give "public" only for a public root Destination. All else is private. */
export function childVisibility(
  visibility: string | null | undefined,
): ConversationPrivacy {
  return visibility === "public" ? "public" : "private";
}

/**
 * Build what a new child saves from its root. A root parent gives its own
 * Location. A child parent passes on the Location that it saved.
 */
export function childSpawnFromParent(
  parent: Conversation,
  rootVisibility: string | null,
): ChildSpawn {
  const location = parent.parentConversationId
    ? parent.spawn?.location
    : parent.location;
  return {
    ...(location ? { location } : undefined),
    visibility: childVisibility(rootVisibility),
  };
}
