import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PluginRoute,
  ResourceEventPublisher,
} from "@sentry/junior-plugin-api";
import { normalizeLinearResourceEvents } from "./resource-events.js";

function verifyLinearSignature(
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

/** Create the public, signed Linear resource-event webhook route. */
export function createLinearWebhookRoute(args: {
  resourceEvents: ResourceEventPublisher;
  webhookSecret(): string | undefined;
}): PluginRoute {
  return {
    method: "POST",
    path: "/api/webhooks/linear",
    async handler(request) {
      const rawBody = await request.text();
      const signature = request.headers.get("linear-signature") ?? "";
      if (!verifyLinearSignature(rawBody, signature, args.webhookSecret())) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = parseJson(rawBody);
      if (body === undefined) {
        return new Response("Malformed Linear webhook", { status: 400 });
      }
      const delivery = request.headers.get("linear-delivery")?.trim();
      const linearEvent = request.headers.get("linear-event")?.trim();
      if (!delivery || !linearEvent) {
        return new Response("Malformed Linear webhook headers", {
          status: 400,
        });
      }
      const events = normalizeLinearResourceEvents({ body, linearEvent });
      for (const event of events) {
        await args.resourceEvents.publish(event);
      }
      return new Response(events.length ? "Accepted" : "Ignored", {
        status: 200,
      });
    },
  };
}
