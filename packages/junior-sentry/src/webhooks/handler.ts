import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PluginRoute,
  ResourceEventPublisher,
} from "@sentry/junior-plugin-api";
import { normalizeSentryResourceEvents } from "./resource-events.js";

function verifySentrySignature(
  body: string,
  signature: string,
  secret: string | undefined,
): boolean {
  if (!secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.toLowerCase());
  const expected = Buffer.from(
    createHmac("sha256", secret).update(body).digest("hex"),
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

/** Create the public, signed Sentry resource-event webhook route. */
export function createSentryWebhookRoute(args: {
  resourceEvents: ResourceEventPublisher;
  webhookOrg(): string | undefined;
  webhookSecret(): string | undefined;
}): PluginRoute {
  return {
    method: "POST",
    path: "/api/webhooks/sentry",
    async handler(request) {
      const rawBody = await request.text();
      const signature = request.headers.get("sentry-hook-signature") ?? "";
      if (!verifySentrySignature(rawBody, signature, args.webhookSecret())) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = parseJson(rawBody);
      if (body === undefined) {
        return new Response("Malformed Sentry webhook", { status: 400 });
      }
      const requestId = request.headers.get("request-id")?.trim();
      const hookResource = request.headers.get("sentry-hook-resource")?.trim();
      if (!requestId || !hookResource) {
        return new Response("Malformed Sentry webhook headers", {
          status: 400,
        });
      }
      const webhookOrg = args.webhookOrg();
      if (!webhookOrg) {
        return new Response("Sentry webhook organization is not configured", {
          status: 503,
        });
      }
      const events = normalizeSentryResourceEvents({
        body,
        hookResource,
        hookTimestamp:
          request.headers.get("sentry-hook-timestamp")?.trim() || undefined,
        webhookOrg,
      });
      for (const event of events) {
        await args.resourceEvents.publish(event);
      }
      return new Response(events.length ? "Accepted" : "Ignored", {
        status: 202,
      });
    },
  };
}
