// The event embeddings group: `createApp({ eventEmbeddings })`.
import * as z from "zod";

/** Whether Junior embeds Conversation events for meaning search. */
export const eventEmbeddingsSchema = z
  .strictObject({ enabled: z.boolean().optional() })
  .prefault({});
