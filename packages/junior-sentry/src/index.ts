/**
 * Sentry plugin runtime boundary.
 *
 * This package owns Sentry OAuth, CLI setup, signed webhook normalization, and
 * Sentry resource identities. Junior core owns watches and event tasks.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { SENTRY_ISSUE_EVENTS } from "./resource-events/issue.js";
import { createSentryWebhookRoute } from "./webhooks/handler.js";
import { sentryWebhookSecret } from "./webhooks/secret.js";

/** Register Sentry runtime metadata and signed resource-event ingress. */
export function sentryPlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-sentry",
    resourceEvents: {
      resourceTypes: [
        {
          type: "issue",
          supportedEvents: [...SENTRY_ISSUE_EVENTS],
          suggestedEvents: [...SENTRY_ISSUE_EVENTS],
        },
        {
          type: "project",
          supportedEvents: [...SENTRY_ISSUE_EVENTS],
          suggestedEvents: [...SENTRY_ISSUE_EVENTS],
        },
      ],
      isEnabled: () => Boolean(sentryWebhookSecret()),
      normalizeIdentifier: (identifier) => identifier.toLowerCase(),
    },
    manifest: {
      commandEnv: {
        SENTRY_AUTH_TOKEN: "host_managed_credential",
      },
      configKeys: ["org", "project"],
      credentials: {
        authTokenEnv: "SENTRY_AUTH_TOKEN",
        authTokenPlaceholder: "host_managed_credential",
        domains: ["sentry.io", "us.sentry.io", "de.sentry.io"],
        type: "oauth-bearer",
      },
      description:
        "Investigate Sentry telemetry, manage alerting, and react to issue events",
      displayName: "Sentry",
      envVars: {
        SENTRY_CLIENT_ID: {},
        SENTRY_CLIENT_SECRET: {},
        SENTRY_WEBHOOK_SECRET: {},
      },
      name: "sentry",
      oauth: {
        authorizeEndpoint: "https://sentry.io/oauth/authorize/",
        clientIdEnv: "SENTRY_CLIENT_ID",
        clientSecretEnv: "SENTRY_CLIENT_SECRET",
        scope:
          "alerts:write event:write member:read org:read project:releases project:write team:write",
        tokenEndpoint: "https://sentry.io/oauth/token/",
      },
      runtimeDependencies: [
        {
          package: "sentry",
          type: "npm",
          version: "latest",
        },
      ],
    },
    hooks: {
      routes(ctx) {
        return [
          createSentryWebhookRoute({
            resourceEvents: ctx.resourceEvents,
            webhookSecret: sentryWebhookSecret,
          }),
        ];
      },
    },
  });
}
