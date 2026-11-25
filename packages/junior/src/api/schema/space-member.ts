import * as z from "zod";

/** One member of a Space. */
export const spaceMemberSchema = z
  .object({
    userId: z.string().min(1),
    email: z.string(),
    displayName: z.string().nullable(),
    /** Junior API path of the member's profile photo. */
    avatarUrl: z.string().nullable(),
    joinedAt: z.iso.datetime(),
  })
  .strict();

export const spaceMemberListSchema = z
  .object({ members: z.array(spaceMemberSchema) })
  .strict();

export type SpaceMemberListReport = z.infer<typeof spaceMemberListSchema>;
