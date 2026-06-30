import { z } from "zod";

export const subscribableResourceSchema = z
  .object({
    label: z.string().min(1),
    provider: z.string().min(1),
    resourceRef: z.string().min(1),
    suggestedEvents: z.array(z.string().min(1)).optional(),
    supportedEvents: z.array(z.string().min(1)),
    type: z.string().min(1),
  })
  .strict();

export type SubscribableResource = z.output<typeof subscribableResourceSchema>;
