/**
 * Who set a Watch. Setting it is a hand-off that Guardian checked
 * (`handoff-check` in `design/guardian.md`), and its Turns serve that
 * instruction (`follows-instruction`).
 */
import { actorSchema, type Actor } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { EventTaskFacts } from "@/chat/events/notification";

/**
 * The person whose instruction the Watch serves, or no Actor when an agent's
 * brief set it. `plugin` names the plugin whose code wrote the intent.
 */
export const watchCreatorSchema = z
  .object({ actor: actorSchema.optional(), plugin: z.string().optional() })
  .strict();

export type WatchCreator = z.output<typeof watchCreatorSchema>;

/**
 * The Watch that started a Turn: who set it, and the saved facts of each
 * Event, whose `instructions` are the Watch's intent.
 */
export interface TurnWatch {
  creator: WatchCreator;
  events: EventTaskFacts[];
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
  if (run.watch) {
    // A Watch that a Watch Turn sets is the agent's, not the plugin's.
    const { plugin: _plugin, ...creator } = run.watch.creator;
    return creator;
  }
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
