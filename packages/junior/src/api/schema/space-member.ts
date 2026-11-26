import * as z from "zod";

/** One member of a Space. */
export const spaceMemberSchema = z
  .object({
    userId: z.string().min(1),
    email: z.string(),
    displayName: z.string().nullable(),
    /** Junior API path of the member's profile photo. */
    avatarUrl: z.string().nullable(),
  })
  .strict();

export const spaceMemberListSchema = z
  .object({ members: z.array(spaceMemberSchema) })
  .strict();

/** Add one person to a Space by the primary email of their User. */
export const addSpaceMemberBodySchema = z
  .object({ email: z.string().trim().min(1).max(320) })
  .strict();

export type SpaceMemberListReport = z.infer<typeof spaceMemberListSchema>;
