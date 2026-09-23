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
} from "./events/deployment.js";
import { createVercelWebhookRoute } from "./webhooks/handler.js";
import { vercelWebhookSecret } from "./webhooks/secret.js";

import { issueVercelCredential, vercelGrantForEgress } from "./credentials.js";
import {
  vercelPreviewOptionsSchema,
  type VercelPreviewOptions,
} from "./preview.js";
import { createVercelPreviewTools } from "./tools/preview.js";

export type { VercelPreviewOptions } from "./preview.js";

/** Host-owned Preview scope; omitted by default to keep all writes disabled. */
export interface VercelPluginOptions {
  preview?: VercelPreviewOptions;
}

/** Register Vercel runtime metadata, tools, and signed webhook ingress. */
export function vercelPlugin(
  options: VercelPluginOptions = {},
): PluginRegistration {
  const preview = options.preview
    ? vercelPreviewOptionsSchema.parse(options.preview)
    : undefined;
  return defineJuniorPlugin({
    packageName: "@sentry/junior-vercel",
    events: {
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
      commandEnv: {
        VERCEL_TOKEN: "host_managed_credential",
      },
      configKeys: ["project", "team"],
      description:
        "Inspect Vercel deployments and logs, monitor outcomes, and optionally manage scoped Previews",
      displayName: "Vercel",
      domains: ["api.vercel.com"],
      envVars: {
        JUNIOR_VERCEL_TOKEN: {},
        JUNIOR_VERCEL_PREVIEW_TOKEN: {},
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
      grantForEgress(ctx) {
        return vercelGrantForEgress(ctx.request, preview);
      },
      issueCredential(ctx) {
        return issueVercelCredential(ctx.grant, preview);
      },
      routes(ctx) {
        return [
          createVercelWebhookRoute({
            events: ctx.events,
            webhookSecret: vercelWebhookSecret,
          }),
        ];
      },
      tools(ctx) {
        const tools = { deployment: createVercelDeploymentTool(ctx) };
        if (preview)
          return { ...tools, ...createVercelPreviewTools(ctx, preview) };
        return tools;
      },
    },
  });
}
