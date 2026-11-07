import { sql, type SQL } from "drizzle-orm";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { juniorConversations } from "@/db/schema";
import {
  CONVERSATION_VISIBILITIES,
  type ConversationVisibility,
} from "@/db/schema/conversations";

// TODO(#2380): Rename legacy `public` to `internal` in ConversationPrivacy
// and its readers. Until then, this storage edge maps the two values.

const visibilityOrder = sql.raw(
  `array[${CONVERSATION_VISIBILITIES.map((value) => `'${value}'`).join(", ")}]::text[]`,
);

function isBelowInternal(visibility: ConversationVisibility): boolean {
  return (
    CONVERSATION_VISIBILITIES.indexOf(visibility) <
    CONVERSATION_VISIBILITIES.indexOf("internal")
  );
}

/** Map a legacy public/private signal. Legacy `public` is the company. */
export function visibilityFromPrivacy(
  privacy: ConversationPrivacy,
): ConversationVisibility {
  return privacy === "public" ? "internal" : "private";
}

/** Map a known Destination value. `unknown` and other values map to nothing. */
export function visibilityFromDestination(
  value: string | null | undefined,
): ConversationVisibility | undefined {
  if (value === "public") return "internal";
  if (value === "private" || value === "direct") return value;
  return undefined;
}

/**
 * Build the stored value for one root Conversation upsert. A known value
 * only moves to a smaller audience. An unknown value takes the inserted
 * value, which is the signal or the known Destination value.
 */
export function nextVisibilitySql(
  signal: ConversationVisibility | undefined,
): SQL {
  const stored = juniorConversations.visibility;
  if (!signal) {
    return sql`coalesce(${stored}, excluded.visibility)`;
  }
  return sql`case
    when array_position(${visibilityOrder}, ${stored}) < array_position(${visibilityOrder}, ${signal}::text) then ${stored}
    else ${signal}
  end`;
}

/**
 * Read the legacy privacy of one Conversation row.
 *
 * A Destination below `internal` makes the Conversation private. Today a
 * channel that becomes private makes all its Conversations private, and this
 * rule keeps that. The cascade in slice 2 of #2380 replaces it. Remove it
 * before step 5 of #2207: it would make a public Conversation in a private
 * DM read as private.
 */
export function readConversationPrivacy(args: {
  conversation: ConversationVisibility | null;
  destination: string | null | undefined;
  isRoot: boolean;
}): ConversationPrivacy | undefined {
  const destination = visibilityFromDestination(args.destination);
  if (destination && isBelowInternal(destination)) {
    return "private";
  }
  // Only roots store a value. Until slice 2 of #2380 moves children to their
  // root, a child reads its own Destination value, as before this column.
  const visibility = args.isRoot ? args.conversation : destination;
  if (!visibility) {
    return undefined;
  }
  return isBelowInternal(visibility) ? "private" : "public";
}
