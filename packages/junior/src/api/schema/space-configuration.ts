import * as z from "zod";

/** One configuration value of a Space. */
export const spaceConfigEntrySchema = z
  .object({
    key: z.string().min(1),
    value: z.json(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

/** A Space's configuration, by key. */
export const spaceConfigurationSchema = z
  .object({ entries: z.array(spaceConfigEntrySchema) })
  .strict();

export type SpaceConfigurationReport = z.infer<typeof spaceConfigurationSchema>;
