/**
 * The core task that attaches the due sent links of one Conversation
 * (`sent-links.ts`). Core registrations load this module, so it loads the
 * attach code only when the task runs.
 */
import type {
  PluginRegistration,
  PluginStartedTaskDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";

export const SENT_LINKS_PLUGIN = "sent-links";
export const SENT_LINKS_ATTACH_TASK = "attach";

const attachPayloadSchema = z
  .object({ conversationId: z.string().min(1) })
  .strict();

const attachTask: PluginStartedTaskDefinition<typeof attachPayloadSchema> = {
  payload: attachPayloadSchema,
  async run(ctx) {
    const { attachSentLinks } = await import("./sent-links");
    await attachSentLinks(Date.now(), {
      conversationId: ctx.payload.conversationId,
    });
  },
};

/**
 * Core task registration that attaches the due sent links of one
 * Conversation. A Turn starts it with `startSentLinksAttach`.
 */
export const sentLinksRegistration: PluginRegistration = {
  manifest: {
    name: SENT_LINKS_PLUGIN,
    displayName: "Sent links",
    description: "Adds the links that people send to linked work",
  },
  tasks: { [SENT_LINKS_ATTACH_TASK]: attachTask },
};
