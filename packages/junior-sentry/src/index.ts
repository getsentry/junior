/**
 * Sentry plugin runtime boundary.
 *
 * This package owns per-user Sentry OAuth, org read access, CLI setup,
 * internal-integration issue and metric alert webhook normalization, and
 * Sentry resource identities. Junior core owns watches and event automations.
 */
import {
  defineJuniorPlugin,
  mergeEventMatchFields,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import {
  SENTRY_ISSUE_EVENTS,
  SENTRY_ISSUE_MATCH_FIELDS,
} from "./events/issue.js";
import {
  SENTRY_METRIC_ALERT_EVENTS,
  SENTRY_METRIC_ALERT_IDENTIFIER,
  SENTRY_METRIC_ALERT_MATCH_FIELDS,
  SENTRY_METRIC_ALERT_SUGGESTED_EVENTS,
} from "./events/metric-alert.js";
import {
  SENTRY_API_DOMAINS,
  issueSentryCredential,
  sentryGrantForEgress,
} from "./org-read.js";
import { resolveSentryOAuthAccount } from "./oauth-account.js";
import { createSentryWebhookRoute } from "./webhooks/handler.js";
import { sentryWebhookSecret } from "./webhooks/secret.js";

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
          matchFields: SENTRY_ISSUE_MATCH_FIELDS,
        },
        {
          type: "project",
          supportedEvents: [
            ...SENTRY_ISSUE_EVENTS,
            ...SENTRY_METRIC_ALERT_EVENTS,
          ],
          suggestedEvents: [
            ...SENTRY_ISSUE_EVENTS,
            ...SENTRY_METRIC_ALERT_SUGGESTED_EVENTS,
          ],
          matchFields: mergeEventMatchFields(
            SENTRY_ISSUE_MATCH_FIELDS,
            SENTRY_METRIC_ALERT_MATCH_FIELDS,
          ),
        },
        {
          type: "metric_alert",
          identifier: SENTRY_METRIC_ALERT_IDENTIFIER,
          supportedEvents: [...SENTRY_METRIC_ALERT_EVENTS],
          suggestedEvents: SENTRY_METRIC_ALERT_SUGGESTED_EVENTS,
          matchFields: SENTRY_METRIC_ALERT_MATCH_FIELDS,
        },
      ],
      // One install is one Sentry org. Issue and metric alert events carry
      // alert facts, and Junior adds nothing to Sentry, so they can run for
      // every project. Use the `projects` filter to narrow them.
      events: Object.fromEntries(
        [...SENTRY_ISSUE_EVENTS, ...SENTRY_METRIC_ALERT_EVENTS].map(
          (eventType) => [eventType, { reach: "all" }],
        ),
      ),
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
        domains: SENTRY_API_DOMAINS,
        type: "oauth-bearer",
      },
      description:
        "Investigate Sentry telemetry, manage projects, teams, and alerting, and receive issue and metric alert webhooks",
      displayName: "Sentry",
      envVars: {
        SENTRY_CLIENT_ID: {},
        SENTRY_CLIENT_SECRET: {},
        SENTRY_READ_TOKEN: {},
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
      resolveOAuthAccount: resolveSentryOAuthAccount,
      routes(ctx) {
        return [
          createSentryWebhookRoute({
            events: ctx.events,
            webhookSecret: sentryWebhookSecret,
          }),
        ];
      },
    },
  });
}
