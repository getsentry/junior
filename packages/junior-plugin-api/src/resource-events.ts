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

export const resourceEventSchema = z
  .object({
    eventKey: z.string().min(1),
    eventType: z.string().min(1),
    occurredAtMs: z.number().finite(),
    provider: z.string().min(1),
    resourceRef: z.string().min(1),
    terminal: z.boolean().optional(),
    trustedSummary: z.string().min(1),
    untrustedText: z.string().optional(),
  })
  .strict();

export type ResourceEvent = z.output<typeof resourceEventSchema>;

export interface ResourceEventPublisher {
  /** Publish one normalized event whose provider matches the owning plugin name. */
  publish(event: ResourceEvent): Promise<void>;
}
