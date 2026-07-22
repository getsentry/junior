import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PluginRoute,
  ResourceEventPublisher,
} from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../pull-request-outcomes/store.js";
import { recordGitHubPullRequestOutcome } from "../pull-request-outcomes/store.js";
import { normalizeGitHubPullRequestOutcome } from "./pull-request-outcome.js";
import { normalizeGitHubResourceEvents } from "./resource-events.js";

/** Verify GitHub's SHA-256 signature against the untouched request body. */
function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string | undefined,
): boolean {
  if (!secret || !signature.startsWith("sha256=")) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Convert malformed signed bodies into an unusable webhook payload. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Create the public, signed GitHub webhook route owned by the plugin. */
export function createGitHubWebhookRoute(args: {
  botEmail(): string | undefined;
  db: GitHubDb;
  resourceEvents: ResourceEventPublisher;
  webhookSecret(): string | undefined;
}): PluginRoute {
  return {
    method: "POST",
    path: "/api/webhooks/github",
    async handler(request) {
      const rawBody = await request.text();
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      if (!verifyGitHubSignature(rawBody, signature, args.webhookSecret())) {
        return new Response("Unauthorized", { status: 401 });
      }
      const deliveryId = request.headers.get("x-github-delivery");
      const eventName = request.headers.get("x-github-event");
      if (!deliveryId || !eventName) {
        return new Response("Malformed GitHub webhook", { status: 400 });
      }

      const body = parseJson(rawBody);
      const outcome =
        eventName === "pull_request"
          ? normalizeGitHubPullRequestOutcome({
              body,
              botEmail: args.botEmail(),
            })
          : undefined;
      if (outcome) {
        await recordGitHubPullRequestOutcome(args.db, outcome);
      }

      const resourceEvents = normalizeGitHubResourceEvents({
        body,
        deliveryId,
        eventName,
      });
      for (const event of resourceEvents) {
        await args.resourceEvents.publish(event);
      }
      if (!outcome && resourceEvents.length === 0) {
        return new Response("Ignored", { status: 202 });
      }
      return new Response("Accepted", { status: 202 });
    },
  };
}
