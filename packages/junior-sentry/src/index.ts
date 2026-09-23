/**
 * Sentry plugin runtime boundary.
 *
 * This package owns user OAuth, read-only service access, CLI setup, internal-integration
 * issue webhook normalization, and Sentry resource identities. Junior core owns
 * watches and event automations.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { SENTRY_ISSUE_EVENTS } from "./events/issue.js";
import { sentryServiceHooks } from "./service-auth.js";
import { createSentryWebhookRoute } from "./webhooks/handler.js";
import { sentryWebhookOrg, sentryWebhookSecret } from "./webhooks/secret.js";

/** Register Sentry runtime metadata and signed event ingress. */
export function sentryPlugin(
  options: { auth?: "oauth" | "service" } = {},
): PluginRegistration {
  const serviceAuth = options.auth === "service";
  return defineJuniorPlugin({
    packageName: "@sentry/junior-sentry",
    events: {
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
      isEnabled: () =>
        Boolean(sentryWebhookSecret()) && Boolean(sentryWebhookOrg()),
      normalizeIdentifier: (identifier) => identifier.toLowerCase(),
    },
    manifest: {
      commandEnv: {
        SENTRY_AUTH_TOKEN: "host_managed_credential",
      },
      configKeys: ["org", "project"],
      ...(serviceAuth
        ? { domains: ["sentry.io", "us.sentry.io", "de.sentry.io"] }
        : {
            credentials: {
              authTokenEnv: "SENTRY_AUTH_TOKEN",
              authTokenPlaceholder: "host_managed_credential",
              domains: ["sentry.io", "us.sentry.io", "de.sentry.io"],
              type: "oauth-bearer" as const,
            },
            oauth: {
              authorizeEndpoint: "https://sentry.io/oauth/authorize/",
              clientIdEnv: "SENTRY_CLIENT_ID",
              clientSecretEnv: "SENTRY_CLIENT_SECRET",
              scope:
                "alerts:write event:write member:read org:read project:releases project:write team:write",
              tokenEndpoint: "https://sentry.io/oauth/token/",
            },
          }),
      description:
        "Investigate Sentry telemetry, manage alerting, and receive issue webhooks",
      displayName: "Sentry",
      envVars: {
        ...(serviceAuth
          ? { SENTRY_SERVICE_TOKEN: {} }
          : { SENTRY_CLIENT_ID: {}, SENTRY_CLIENT_SECRET: {} }),
        SENTRY_WEBHOOK_ORG: {},
        SENTRY_WEBHOOK_SECRET: {},
      },
      name: "sentry",
      runtimeDependencies: [
        {
          package: "sentry",
          type: "npm",
          version: "latest",
        },
      ],
    },
    hooks: {
      grantForEgress: serviceAuth
        ? sentryServiceHooks.grantForEgress
        : undefined,
      issueCredential: serviceAuth
        ? sentryServiceHooks.issueCredential
        : undefined,
      onEgressResponse: serviceAuth
        ? sentryServiceHooks.onEgressResponse
        : undefined,
      routes(ctx) {
        return [
          createSentryWebhookRoute({
            events: ctx.events,
            webhookOrg: sentryWebhookOrg,
            webhookSecret: sentryWebhookSecret,
          }),
        ];
      },
    },
  });
}
