import { defineConversationEvent } from "@sentry/junior-plugin-api";
import * as z from "zod";

function renderBriefUpdated(event: { version: number }) {
  return {
    icon: "activity" as const,
    title: `Brief updated (v${event.version})`,
  };
}

/** Previous stored Brief event shape retained for transcript rendering. */
export const briefUpdatedEventV1 = defineConversationEvent({
  name: "brief_updated",
  version: 1,
  schema: z
    .object({
      version: z.number().int().positive(),
      modelId: z.string().min(1),
      costUsd: z.number().finite().nonnegative().optional(),
      decisions: z.number().int().nonnegative(),
      openDecisions: z.number().int().nonnegative(),
      links: z.number().int().nonnegative(),
    })
    .strict(),
  renderEvent: renderBriefUpdated,
});

/** Durable cost and size record for one stored Brief version. */
export const briefUpdatedEvent = defineConversationEvent({
  name: "brief_updated",
  version: 2,
  schema: z
    .object({
      version: z.number().int().positive(),
      modelId: z.string().min(1),
      costUsd: z.number().finite().nonnegative().optional(),
      decisions: z.number().int().nonnegative(),
      links: z.number().int().nonnegative(),
    })
    .strict(),
  renderEvent: renderBriefUpdated,
});
