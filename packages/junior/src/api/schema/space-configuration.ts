import * as z from "zod";

/** One configuration value of a Space. */
export const spaceConfigEntrySchema = z
  .object({
    key: z.string().min(1),
    value: z.json(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

/**
 * A Space's configuration. `keys` lists the keys that installed plugins
 * read, so a member can pick one.
 */
export const spaceConfigurationSchema = z
  .object({
    entries: z.array(spaceConfigEntrySchema),
    keys: z.array(z.string()),
  })
  .strict();

/** Route parameters of one configuration key of a Space. */
export const spaceConfigKeyParamsSchema = z
  .object({
    spaceId: z.string().uuid(),
    key: z.string().trim().min(1).max(200),
  })
  .strict();

/** Set one configuration value of a Space. */
export const setSpaceConfigBodySchema = z.object({ value: z.json() }).strict();

export type SpaceConfigurationReport = z.infer<typeof spaceConfigurationSchema>;
