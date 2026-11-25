import * as z from "zod";

const SPACE_NAME_MAX_CHARS = 80;
const SPACE_DESCRIPTION_MAX_CHARS = 500;

const spaceNameSchema = z.string().trim().min(1).max(SPACE_NAME_MAX_CHARS);
const spaceDescriptionSchema = z
  .string()
  .trim()
  .max(SPACE_DESCRIPTION_MAX_CHARS)
  .transform((value) => value || null)
  .nullable();

export const spaceParamsSchema = z
  .object({ spaceId: z.string().uuid() })
  .strict();

export const spaceListQuerySchema = z
  .object({
    /** `member`, the default, returns only the viewer's Spaces. */
    membership: z.enum(["member", "all"]).default("member"),
    archived: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .strict();

export const createSpaceBodySchema = z
  .object({
    name: spaceNameSchema,
    description: spaceDescriptionSchema.optional(),
  })
  .strict();

export const updateSpaceBodySchema = z
  .object({
    name: spaceNameSchema.optional(),
    description: spaceDescriptionSchema.optional(),
  })
  .strict()
  .refine(
    (body) => body.name !== undefined || body.description !== undefined,
    "Change the name or the description.",
  );

export const archiveSpaceBodySchema = z
  .object({ archived: z.boolean() })
  .strict();

/** The id and name that label the Space of a Conversation. */
export const spaceRefSchema = z
  .object({ id: z.string().uuid(), name: z.string().min(1) })
  .strict();

/** One Space, as the viewer sees it. Every Space is public. */
export const spaceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    description: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
    memberCount: z.number().int().nonnegative(),
    viewerIsMember: z.boolean(),
  })
  .strict();

export const spaceListSchema = z
  .object({ spaces: z.array(spaceSchema) })
  .strict();

export type SpaceRefReport = z.infer<typeof spaceRefSchema>;
export type SpaceReport = z.infer<typeof spaceSchema>;
export type SpaceListReport = z.infer<typeof spaceListSchema>;
