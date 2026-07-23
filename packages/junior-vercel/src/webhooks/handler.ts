/**
 * Owns signed Vercel webhook ingress for the plugin.
 *
 * Verification precedes parsing, only verified events reach normalization, and
 * publish failures propagate so Vercel can retry the delivery.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PluginRoute,
  ResourceEventPublisher,
} from "@sentry/junior-plugin-api";
import { normalizeVercelResourceEvents } from "./resource-events.js";

/** Verify Vercel's SHA-1 signature against the untouched request body. */
function verifyVercelSignature(
  body: string,
  signature: string,
  secret: string | undefined,
): boolean {
  if (!secret || !/^[0-9a-f]{40}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.toLowerCase());
  // Vercel mandates HMAC-SHA1 for x-vercel-signature; SHA-2 is not protocol-compatible.
  // https://vercel.com/docs/headers/request-headers#x-vercel-signature
  const expected = Buffer.from(
    createHmac("sha1", secret).update(body).digest("hex"),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Create the public, signed Vercel deployment webhook route. */
export function createVercelWebhookRoute(args: {
  resourceEvents: ResourceEventPublisher;
  webhookSecret(): string | undefined;
}): PluginRoute {
  return {
    method: "POST",
    path: "/api/webhooks/vercel",
    async handler(request) {
      const rawBody = await request.text();
      const signature = request.headers.get("x-vercel-signature") ?? "";
      if (!verifyVercelSignature(rawBody, signature, args.webhookSecret())) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = parseJson(rawBody);
      if (body === undefined) {
        return new Response("Malformed Vercel webhook", { status: 400 });
      }
      const resourceEvents = normalizeVercelResourceEvents({ body });
      for (const event of resourceEvents) {
        await args.resourceEvents.publish(event);
      }
      return new Response(resourceEvents.length ? "Accepted" : "Ignored", {
        status: 202,
      });
    },
  };
}
