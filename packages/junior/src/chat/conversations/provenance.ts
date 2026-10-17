/**
 * Durable message attribution shared by storage and projections.
 * Attribution never grants credential authority.
 */
import { actorSchema, type Actor } from "@sentry/junior-plugin-api";
import { z } from "zod";

const conversationMessageAuthoritySchema = z.union([
  z.literal("instruction"),
  z.literal("context"),
]);

/** Canonical authority and actor metadata for one durable message event. */
export const conversationMessageProvenanceSchema = z
  .object({
    authority: conversationMessageAuthoritySchema,
    /** Who wrote the message. Agent-written text has none. */
    actor: actorSchema.optional(),
    /** Whose work an agent-written instruction serves. Runtime-only. */
    onBehalfOf: actorSchema.optional(),
  })
  .strict();

/** Whether a message is a durable instruction or ambient conversation context. */
export type ConversationMessageAuthority = z.output<
  typeof conversationMessageAuthoritySchema
>;

/** Actor and authority metadata aligned with one durable message event. */
export type ConversationMessageProvenance = z.output<
  typeof conversationMessageProvenanceSchema
>;

/** Build instruction provenance for an optional actor. */
export function instructionProvenanceFor(
  actor: Actor | undefined,
): ConversationMessageProvenance {
  return actor
    ? { authority: "instruction", actor }
    : { authority: "instruction" };
}

/**
 * Provenance of an instruction that an agent wrote, such as a parent agent
 * task in a child Conversation. It has no Actor, so it never counts as user
 * intent. `onBehalfOf` is the Actor whose work the instruction serves. Only
 * the runtime sets it, and it never makes that Actor the writer.
 */
export function agentInstructionProvenanceFor(
  onBehalfOf: Actor | undefined,
): ConversationMessageProvenance {
  return onBehalfOf
    ? { authority: "instruction", onBehalfOf }
    : { authority: "instruction" };
}

/** Unattributed ambient-context provenance for non-instruction messages. */
export const contextProvenance: ConversationMessageProvenance = {
  authority: "context",
};

function actorIdentityKey(actor: Actor): string {
  if (actor.platform === "system") {
    return `system ${actor.name}`;
  }
  return actor.platform === "slack"
    ? `slack\u0000${actor.teamId}\u0000${actor.userId}`
    : `${actor.platform}\u0000${actor.userId}`;
}

/** Compare two actors by runtime identity only, never by display metadata. */
export function sameActorIdentity(
  left: Actor | undefined,
  right: Actor | undefined,
): boolean {
  return Boolean(
    left && right && actorIdentityKey(left) === actorIdentityKey(right),
  );
}

/**
 * Return distinct instruction actors in first-seen order for attribution only.
 * Never use this list as credential authority.
 */
export function instructionActors(
  provenance: ConversationMessageProvenance[],
): Actor[] {
  const seen = new Set<string>();
  const actors: Actor[] = [];
  for (const entry of provenance) {
    if (entry.authority !== "instruction" || !entry.actor) {
      continue;
    }
    const identity = actorIdentityKey(entry.actor);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    actors.push(entry.actor);
  }
  return actors;
}
