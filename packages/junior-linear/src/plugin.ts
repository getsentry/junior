import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import {
  LINEAR_ISSUE_EVENTS,
  LINEAR_ISSUE_MATCH_FIELDS,
} from "./resource-events/issue.js";
import { createLinearTools } from "./tools.js";
import { createLinearWebhookRoute } from "./webhooks/handler.js";
import { linearWebhookSecret } from "./webhooks/secret.js";

/** Register Linear OAuth, tools, and issue webhooks. */
export function linearPlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-linear",
    resourceEvents: {
      resourceTypes: [
        {
          type: "issue",
          supportedEvents: [...LINEAR_ISSUE_EVENTS],
          suggestedEvents: [...LINEAR_ISSUE_EVENTS],
          matchFields: LINEAR_ISSUE_MATCH_FIELDS,
        },
        {
          type: "team",
          supportedEvents: [...LINEAR_ISSUE_EVENTS],
          suggestedEvents: [...LINEAR_ISSUE_EVENTS],
          matchFields: LINEAR_ISSUE_MATCH_FIELDS,
        },
      ],
      isEnabled: () => Boolean(linearWebhookSecret()),
      normalizeIdentifier: (identifier) => identifier.toUpperCase(),
    },
    manifest: {
      commandEnv: {
        LINEAR_ACCESS_TOKEN: "host_managed_credential",
      },
      configKeys: ["team", "project"],
      credentials: {
        authTokenEnv: "LINEAR_ACCESS_TOKEN",
        authTokenPlaceholder: "host_managed_credential",
        domains: ["api.linear.app"],
        type: "oauth-bearer",
      },
      description:
        "Read and update Linear through an installed OAuth app, with optional issue webhooks",
      displayName: "Linear",
      envVars: {
        LINEAR_CLIENT_ID: {},
        LINEAR_CLIENT_SECRET: {},
        LINEAR_WEBHOOK_SECRET: {},
      },
      name: "linear",
      oauth: {
        authorizeEndpoint: "https://linear.app/oauth/authorize",
        authorizeParams: { actor: "app" },
        clientIdEnv: "LINEAR_CLIENT_ID",
        clientSecretEnv: "LINEAR_CLIENT_SECRET",
        scope: "read,write",
        tokenEndpoint: "https://api.linear.app/oauth/token",
        tokenSubject: "installation",
      },
    },
    hooks: {
      routes(ctx) {
        return [
          createLinearWebhookRoute({
            resourceEvents: ctx.resourceEvents,
            webhookSecret: linearWebhookSecret,
          }),
        ];
      },
      tools: createLinearTools,
    },
  });
}
