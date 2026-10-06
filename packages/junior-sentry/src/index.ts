/**
 * Sentry plugin runtime boundary.
 *
 * This package owns per-user Sentry OAuth, org-wide read access, CLI setup,
 * internal-integration issue webhook normalization, and Sentry resource
 * identities. Junior core owns watches and event automations.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { SENTRY_ISSUE_EVENTS } from "./events/issue.js";
import {
  SENTRY_API_DOMAINS,
  SENTRY_READ_ORG_ENV,
  SENTRY_READ_TOKEN_ENV,
  issueSentryCredential,
  sentryGrantForEgress,
} from "./org-read.js";
import { createSentryWebhookRoute } from "./webhooks/handler.js";
import { sentryWebhookOrg, sentryWebhookSecret } from "./webhooks/secret.js";

/** Register Sentry runtime metadata and signed event ingress. */
export function sentryPlugin(): PluginRegistration {
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
      credentials: {
        authTokenEnv: "SENTRY_AUTH_TOKEN",
        authTokenPlaceholder: "host_managed_credential",
        domains: [...SENTRY_API_DOMAINS],
        type: "oauth-bearer",
      },
      description:
        "Investigate Sentry telemetry, manage alerting, and receive issue webhooks",
      displayName: "Sentry",
      envVars: {
        SENTRY_CLIENT_ID: {},
        SENTRY_CLIENT_SECRET: {},
        [SENTRY_READ_ORG_ENV]: {},
        [SENTRY_READ_TOKEN_ENV]: {},
        SENTRY_WEBHOOK_ORG: {},
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
      grantForEgress: sentryGrantForEgress,
      issueCredential: issueSentryCredential,
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
