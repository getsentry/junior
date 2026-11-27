/**
 * Who set a Watch. A Watch Turn serves the instruction that created the
 * Watch (`follows-instruction` in `design/guardian.md`), so the agent
 * Guardian reads that creator's own lines and the Watch's instructions.
 */
import { actorSchema, type Actor } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";

/** A person Actor, or no Actor when an agent's brief set the Watch. */
export const watchCreatorSchema = z
  .object({ actor: actorSchema.optional() })
  .strict();

export type WatchCreator = z.output<typeof watchCreatorSchema>;

/** The Watch that started a Turn: who set it and what it said to do. */
export interface TurnWatch {
  creator: WatchCreator;
  intents: string[];
}

/**
 * Return who sets a Watch in this Run: the requester of the Run's
 * instructions, the same one whose lines Guardian reads. A Watch Turn passes
 * on its own creator. A Run with no requester, such as another Event Turn,
 * sets a Watch with no creator.
 */
export function watchCreatorFor(run: {
  actor?: Actor | undefined;
  provenance?: ConversationMessageProvenance | undefined;
  watch?: TurnWatch | undefined;
}): WatchCreator | undefined {
  if (run.watch) return run.watch.creator;
  if (run.provenance) {
    return run.provenance.authority === "instruction"
      ? run.provenance.actor
        ? { actor: run.provenance.actor }
        : {}
      : undefined;
  }
  return run.actor && run.actor.platform !== "system"
    ? { actor: run.actor }
    : undefined;
}
