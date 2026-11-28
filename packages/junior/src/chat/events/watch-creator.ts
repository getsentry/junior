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
 * The person whose instruction the Watch serves. `brief` marks a Watch that a
 * Run set from an agent's brief: the brief is that person's instruction
 * there. `plugin` names the plugin whose code wrote the intent.
 */
export const watchCreatorSchema = z
  .object({
    actor: actorSchema.optional(),
    brief: z.literal(true).optional(),
    plugin: z.string().optional(),
  })
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
 * Return who sets a Watch in this Run: the person whose instruction the Run
 * serves. A Run that follows an agent's brief, such as a child, serves the
 * person the brief serves, its Actor. A Watch Turn passes on its own
 * creator. A Run with no requester, such as another Event Turn, sets a Watch
 * with no creator.
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
  const person =
    run.actor && run.actor.platform !== "system" ? run.actor : undefined;
  if (run.provenance) {
    if (run.provenance.authority !== "instruction") return undefined;
    return run.provenance.actor
      ? { actor: run.provenance.actor }
      : { ...(person ? { actor: person } : undefined), brief: true };
  }
  return person ? { actor: person } : undefined;
}
