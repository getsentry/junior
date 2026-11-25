import * as z from "zod";
import { spaceRefSchema } from "./space";

/** Body of `PUT /api/conversations/:conversationId/space`. */
export const setConversationSpaceBodySchema = z
  .object({
    /** The Space to put the root in, or null to make it a one-off. */
    spaceId: z.string().uuid().nullable(),
  })
  .strict();

export const setConversationSpaceResponseSchema = z
  .object({ space: spaceRefSchema.nullable() })
  .strict();

export type SetConversationSpaceBody = z.infer<
  typeof setConversationSpaceBodySchema
>;
export type SetConversationSpaceResponse = z.infer<
  typeof setConversationSpaceResponseSchema
>;
