/**
 * Vercel plugin runtime boundary.
 *
 * This package owns Vercel CLI setup, host-managed API authentication, signed
 * webhook normalization, and deployment tools. Junior core owns the resulting
 * conversation subscriptions and event delivery.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { createVercelDeploymentTool } from "./tools/deployment.js";
import {
  VERCEL_DEPLOYMENT_EVENTS,
  VERCEL_DEPLOYMENT_SUGGESTED_EVENTS,
} from "./resource-events/deployment.js";
import { createVercelWebhookRoute } from "./webhooks/handler.js";
import { vercelWebhookSecret } from "./webhooks/secret.js";

/** Register Vercel runtime metadata, tools, and signed webhook ingress. */
export function vercelPlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-vercel",
    resourceEvents: {
      resourceTypes: [
        {
          type: "deployment",
          supportedEvents: [...VERCEL_DEPLOYMENT_EVENTS],
          suggestedEvents: [...VERCEL_DEPLOYMENT_SUGGESTED_EVENTS],
        },
      ],
      isEnabled: () => Boolean(vercelWebhookSecret()),
    },
    manifest: {
      apiHeaders: {
        Authorization: "Bearer ${JUNIOR_VERCEL_TOKEN}",
      },
      commandEnv: {
        VERCEL_TOKEN: "host_managed_credential",
      },
      configKeys: ["project", "team"],
      description:
        "Query Vercel deployments and logs and monitor deployment outcomes",
      displayName: "Vercel",
      domains: ["api.vercel.com"],
      envVars: {
        JUNIOR_VERCEL_TOKEN: {},
        VERCEL_WEBHOOK_SECRET: {},
      },
      name: "vercel",
      runtimeDependencies: [
        {
          package: "vercel",
          type: "npm",
          version: "latest",
        },
      ],
    },
    hooks: {
      routes(ctx) {
        return [
          createVercelWebhookRoute({
            resourceEvents: ctx.resourceEvents,
            webhookSecret: vercelWebhookSecret,
          }),
        ];
      },
      tools(ctx) {
        return {
          deployment: createVercelDeploymentTool(ctx),
        };
      },
    },
  });
}
