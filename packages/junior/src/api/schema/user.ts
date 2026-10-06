import { z } from "zod";

export const contextDistillationPreferenceSchema = z
  .object({ available: z.boolean(), enabled: z.boolean() })
  .strict();

export const updateContextDistillationPreferenceSchema = z
  .object({ enabled: z.boolean() })
  .strict();
