// Port of chat/pi/gateway-routing-attributes.ts. Keep the two in step: the
// span drift test compares them.
import * as z from "zod";

// AI Gateway reports how it routed an Anthropic Messages request in
// `provider_metadata.gateway.routing` on the streamed `message_delta` event.
// Each upstream provider and credential keeps its own prompt cache, so these
// attributes show when a cache miss follows a provider or credential change.
// See https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity
// and https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering.
// The metadata is opaque and only diagnostic, so unknown fields are ignored.

const providerAttemptSchema = z.object({
  success: z.boolean().optional(),
  credentialType: z.string().optional(),
  // Present only when the request pins an inference region.
  inferenceEndpoint: z.object({ geoRegion: z.string().optional() }).optional(),
});

const routingSchema = z.object({
  finalProvider: z.string().optional(),
  totalProviderAttemptCount: z.number().optional(),
  // `explicit` when the gateway used the session ID that Pi sent,
  // `fingerprint` when it derived one from the request.
  clientSessionIdSource: z.string().optional(),
  // Present when the gateway looked at a session pin. `pinned` is true when
  // it tried the pinned provider first. `outcome` explains a skipped pin.
  affinity: z
    .object({
      pinned: z.boolean().optional(),
      pinnedProvider: z.string().optional(),
      outcome: z.string().optional(),
    })
    .optional(),
  modelAttempts: z
    .array(
      z.object({
        providerAttempts: z.array(providerAttemptSchema).optional(),
      }),
    )
    .optional(),
});

const messageDeltaSchema = z.object({
  type: z.literal("message_delta"),
  provider_metadata: z.object({
    gateway: z.object({ routing: routingSchema }),
  }),
});

/**
 * Read the provider routing of one Anthropic Messages stream event as
 * `app.ai.gateway.*` span attributes. Returns undefined for any other event.
 */
export function routingAttributes(
  event: unknown,
): Record<string, string | number | boolean> | undefined {
  const parsed = messageDeltaSchema.safeParse(event);
  if (!parsed.success) {
    return undefined;
  }
  const routing = parsed.data.provider_metadata.gateway.routing;
  // Only the provider attempt that served the request succeeded.
  const served = routing.modelAttempts
    ?.flatMap((attempt) => attempt.providerAttempts ?? [])
    .find((attempt) => attempt.success === true);
  const attributes: Record<string, string | number | boolean> = {};
  const set = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) {
      attributes[`app.ai.gateway.${key}`] = value;
    }
  };
  set("provider", routing.finalProvider);
  set("credential_type", served?.credentialType);
  set("region", served?.inferenceEndpoint?.geoRegion);
  set("provider_attempts", routing.totalProviderAttemptCount);
  set("session_id_source", routing.clientSessionIdSource);
  set("affinity.pinned", routing.affinity?.pinned);
  set("affinity.pinned_provider", routing.affinity?.pinnedProvider);
  set("affinity.outcome", routing.affinity?.outcome);
  return attributes;
}
