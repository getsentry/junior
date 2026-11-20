import { describe, expect, it } from "vitest";
import { gatewayRoutingAttributes } from "@/chat/pi/gateway-routing-attributes";

const MODEL_ID = "anthropic/claude-opus-5.5";

// A `message_delta` event as AI Gateway streams it on `/v1/messages`, cut
// down from a recorded response.
function messageDelta(routing: Record<string, unknown>) {
  return {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 10 },
    provider_metadata: {
      anthropic: { usage: { inference_geo: "global" } },
      gateway: { routing, cost: "0.00134", generationId: "gen_01TEST" },
    },
  };
}

describe("gatewayRoutingAttributes", () => {
  it("reads the provider that served the request after a failover", () => {
    // Bedrock held the session pin and failed, so Anthropic served it.
    const event = messageDelta({
      originalModelId: MODEL_ID,
      resolvedProvider: "bedrock",
      fallbacksAvailable: ["anthropic", "vertexAnthropic"],
      finalProvider: "anthropic",
      modelAttemptCount: 1,
      modelAttempts: [
        {
          canonicalSlug: MODEL_ID,
          success: true,
          providerAttemptCount: 2,
          providerAttempts: [
            {
              provider: "bedrock",
              credentialType: "system",
              success: false,
              error: "Service temporarily unavailable",
              statusCode: 503,
            },
            {
              provider: "anthropic",
              credentialType: "system",
              success: true,
              statusCode: 200,
              inferenceEndpoint: {
                slug: "geo-us",
                scope: "zone",
                geoRegion: "us",
              },
            },
          ],
        },
      ],
      totalProviderAttemptCount: 2,
      affinity: { pinned: true, pinnedProvider: "bedrock" },
      clientSessionId: "conversation-1",
      clientSessionIdSource: "explicit",
    });

    expect(gatewayRoutingAttributes(event)).toEqual({
      "app.ai.gateway.provider": "anthropic",
      "app.ai.gateway.credential_type": "system",
      "app.ai.gateway.region": "us",
      "app.ai.gateway.provider_attempts": 2,
      "app.ai.gateway.session_id_source": "explicit",
      "app.ai.gateway.affinity.pinned": true,
      "app.ai.gateway.affinity.pinned_provider": "bedrock",
    });
  });

  it("omits fields that the gateway did not report", () => {
    const event = messageDelta({
      finalProvider: "anthropic",
      modelAttempts: [
        {
          success: true,
          providerAttempts: [
            { provider: "anthropic", credentialType: "system", success: true },
          ],
        },
      ],
      totalProviderAttemptCount: 1,
      affinity: { outcome: "skipped_below_min_prefix" },
      clientSessionIdSource: "fingerprint",
    });

    expect(gatewayRoutingAttributes(event)).toEqual({
      "app.ai.gateway.provider": "anthropic",
      "app.ai.gateway.credential_type": "system",
      "app.ai.gateway.provider_attempts": 1,
      "app.ai.gateway.session_id_source": "fingerprint",
      "app.ai.gateway.affinity.outcome": "skipped_below_min_prefix",
    });
  });

  it("ignores events without gateway routing", () => {
    expect(
      gatewayRoutingAttributes({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 10 },
      }),
    ).toBeUndefined();
    expect(
      gatewayRoutingAttributes({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }),
    ).toBeUndefined();
  });
});
