import { defineConversationEvent } from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Durable record of one classifier assignment and its model cost. */
export const spaceAssignedEvent = defineConversationEvent({
  name: "space_assigned",
  version: 1,
  schema: z
    .object({
      spaceId: z.string().min(1),
      path: z.array(z.string().min(1)).min(1),
      created: z.boolean(),
      confidence: z.number().min(0).max(1),
      modelId: z.string().min(1),
      costUsd: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  renderEvent(event) {
    return {
      icon: "sparkles",
      title: `${event.created ? "Created Space" : "Assigned to Space"} ${event.path.join(" › ")}`,
    };
  },
});
