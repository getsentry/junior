import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  EventPublisher,
  PluginContext,
  PluginRoute,
} from "@sentry/junior-plugin-api";
import { activeSentryInstallations } from "../installations/store.js";
import type { SentryAppConfig } from "../installations/tokens.js";
import { handleSentryInstallationWebhook } from "../installations/webhook.js";
import { normalizeSentryEvents } from "./events.js";

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

function installationUuid(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const installation = (body as { installation?: unknown }).installation;
  if (!installation || typeof installation !== "object") return undefined;
  const uuid = (installation as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid ? uuid : undefined;
}

function ignored(): Response {
  return new Response("Ignored", { status: 202 });
}

/**
 * Create the public, signed Sentry event webhook route.
 *
 * The public integration and the internal integration sign with their own
 * client secrets. A delivery from the public integration must come from an
 * active installation, except the `installation` webhook that creates one.
 */
export function createSentryWebhookRoute(args: {
  appConfig(): SentryAppConfig | undefined;
  ctx: Pick<PluginContext, "cache" | "db">;
  events: EventPublisher;
  webhookSecret(): string | undefined;
}): PluginRoute {
  return {
    method: "POST",
    path: "/api/webhooks/sentry",
    async handler(request) {
      const rawBody = await request.text();
      const signature = request.headers.get("sentry-hook-signature") ?? "";
      const appConfig = args.appConfig();
      const fromApp = verifySentrySignature(
        rawBody,
        signature,
        appConfig?.clientSecret,
      );
      if (
        !fromApp &&
        !verifySentrySignature(rawBody, signature, args.webhookSecret())
      ) {
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
      if (fromApp && appConfig) {
        if (hookResource === "installation") {
          const handled = await handleSentryInstallationWebhook(
            args.ctx,
            appConfig,
            body,
          );
          return handled
            ? new Response("Accepted", { status: 202 })
            : ignored();
        }
        const uuid = installationUuid(body);
        const installations = await activeSentryInstallations(args.ctx);
        if (
          !installations.some(
            (installation) => installation.installationUuid === uuid,
          )
        ) {
          return ignored();
        }
      }
      const events = normalizeSentryEvents({
        body,
        hookResource,
        hookTimestamp:
          request.headers.get("sentry-hook-timestamp")?.trim() || undefined,
      });
      for (const event of events) {
        await args.events.publish(event);
      }
      return events.length
        ? new Response("Accepted", { status: 202 })
        : ignored();
    },
  };
}
