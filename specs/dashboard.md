# Dashboard Spec

## Metadata

- Created: 2026-05-29
- Last Edited: 2026-05-30

## Purpose

Define Junior's authenticated dashboard route, browser-session auth model, and read-only reporting boundary.

## Scope

- Dashboard route ownership for human-facing diagnostics.
- Better Auth configuration for browser sessions.
- Google domain and email authorization policy.
- In-process reporting interfaces exported by `@sentry/junior`.
- Nitro integration for mounting dashboard routes into the same deployment as Junior.

## Non-Goals

- Slack, provider OAuth, sandbox egress, or internal worker authentication.
- A dashboard-specific database, user table, or persistent session store.
- A remote reporting HTTP API.
- Model-facing access to dashboard data.
- Per-session or per-user revocation without storage.

## Packages And Exports

Dashboard functionality lives outside the core Junior runtime package.

```txt
packages/junior/
  src/reporting/**

packages/junior-dashboard/
  src/app.ts
  src/auth.ts
  src/client/**
  src/config.ts
  src/handler.ts
  src/nitro.ts
```

`@sentry/junior` exports a read-only reporting surface:

```ts
export interface JuniorReporting {
  getHealth(): Promise<HealthReport>;
  getRuntimeInfo(): Promise<RuntimeInfoReport>;
  getPlugins(): Promise<PluginReport[]>;
  getSkills(): Promise<SkillReport[]>;
  getSessions(): Promise<DashboardSessionFeed>;
  getConversation(conversationId: string): Promise<DashboardConversationReport>;
}

export function createJuniorReporting(): JuniorReporting;
```

Every exported reporting function must have a brief JSDoc comment explaining why the data is exposed.

`@sentry/junior-dashboard/nitro` exports:

```ts
export interface JuniorDashboardNitroOptions {
  basePath?: string;
  authPath?: string;
  authRequired?: boolean;
  allowedGoogleDomains?: string[];
  allowedEmails?: string[];
  trustedOrigins?: string[];
  sessionMaxAgeSeconds?: number;
  disabled?: boolean;
}

export function juniorDashboardNitro(options: JuniorDashboardNitroOptions): {
  nitro: { setup(nitro: unknown): void };
};
```

`authRequired` defaults to `true`. Setting `authRequired: false` is only for explicit local/demo deployments and must bypass dashboard auth only for dashboard routes. Production configuration must not silently disable dashboard auth.

`disabled` disables route registration entirely and is only for explicit local/demo deployments.

## Route Contract

Junior health routes are machine-facing health checks:

| Route         | Auth   | Contract                                |
| ------------- | ------ | --------------------------------------- |
| `GET /health` | public | Minimal health/readiness JSON response. |

The dashboard package owns browser-facing routes:

| Route                   | Auth                                                   | Contract                            |
| ----------------------- | ------------------------------------------------------ | ----------------------------------- |
| `GET /`                 | Better Auth session unless auth is explicitly disabled | React command-center UI.            |
| `GET /conversations`    | Better Auth session unless auth is explicitly disabled | React conversation-history UI.      |
| `GET /conversations/**` | Better Auth session unless auth is explicitly disabled | React conversation-detail UI.       |
| `GET /sessions/**`      | Better Auth session unless auth is explicitly disabled | Compatibility redirect UI.          |
| `GET /api/dashboard/**` | Better Auth session unless auth is explicitly disabled | Dashboard JSON APIs.                |
| `/api/auth/**`          | Better Auth                                            | Better Auth social login callbacks. |

Dashboard JSON APIs are split by view concern:

| Route                                            | Contract                                            |
| ------------------------------------------------ | --------------------------------------------------- |
| `GET /api/dashboard/health`                      | Command-center health pulse.                        |
| `GET /api/dashboard/runtime`                     | Sanitized runtime paths, packages, and providers.   |
| `GET /api/dashboard/plugins`                     | Loaded plugin inventory.                            |
| `GET /api/dashboard/skills`                      | Discovered skill inventory.                         |
| `GET /api/dashboard/sessions`                    | Conversation feed from recent turn-session records. |
| `GET /api/dashboard/conversations/:conversation` | Conversation transcript from expiring session logs. |
| `GET /api/dashboard/config`                      | Safe config counts, timezone, and feature signals.  |
| `GET /api/dashboard/me`                          | Signed-in dashboard identity.                       |

The current public diagnostics surfaces must move behind dashboard auth:

- The HTML diagnostics page stays at `/` when the dashboard package is mounted, but requires dashboard auth.
- Runtime diagnostics JSON moves from `/api/info` to `/api/dashboard/info`.
- `/api/info` must not expose cwd, home directory, plugins, skills, packaged content, or other runtime discovery data publicly.

Existing Junior runtime routes keep their existing auth models and must not be wrapped by dashboard auth:

- `/api/webhooks/**`
- `/api/oauth/callback/**`
- `/api/internal/**`
- sandbox egress proxy requests
- `/health`

## Better Auth Contract

The dashboard uses Better Auth in stateless mode.

Required properties:

1. Do not configure a Better Auth database for the dashboard.
2. Store browser session state in cryptographically protected `HttpOnly` cookies.
3. Mark cookies `Secure` outside local development.
4. Use `SameSite=Lax` unless Better Auth requires a stricter provider-compatible setting.
5. Configure `baseURL`, `secret`, and `trustedOrigins`.
6. Configure Google as the only required social provider.
7. Do not persist Google access tokens, refresh tokens, user records, or account records for the dashboard.

Required environment/config inputs when dashboard auth is enabled:

- `JUNIOR_SECRET`, or optional `BETTER_AUTH_SECRET` override
- dashboard origin from optional `BETTER_AUTH_URL`, `JUNIOR_BASE_URL`, Vercel URL envs, or local dev
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- dashboard origin or trusted origins
- `allowedGoogleDomains` from Nitro config or `JUNIOR_DASHBOARD_GOOGLE_DOMAINS`
- optional `allowedEmails` from Nitro config or `JUNIOR_DASHBOARD_ALLOWED_EMAILS`
- optional `JUNIOR_DASHBOARD_AUTH_REQUIRED=false` for explicit local auth bypass

`JUNIOR_DASHBOARD_TRUSTED_ORIGINS` is allowed as the env equivalent of `trustedOrigins`. Dashboard list env vars may be comma-separated strings or JSON string arrays.

Session lifetime defaults to eight hours. Session refresh is disabled unless a future spec adds a reason for long-lived dashboard sessions.

## Authorization Policy

Authentication proves the browser user completed Google login. Authorization is a separate dashboard check.

After Better Auth resolves a session, dashboard middleware must allow the request only when one of these is true:

1. The verified Google hosted-domain claim is in `allowedGoogleDomains`.
2. The verified email address is in `allowedEmails`.

The Google `hd` authorization request parameter is only a login hint. It must not be treated as authorization by itself.

Email suffix checks are not a substitute for the Google hosted-domain claim when domain authorization is configured. `allowedEmails` is the explicit exception path for individual accounts.

If auth is enabled and no domains and no emails are configured, dashboard route setup must fail closed.

## Reporting Contract

The dashboard reads Junior data through in-process reporting interfaces. It must not import legacy diagnostics handlers or other private route handlers.

Reporting interfaces are read-only and must not:

- mutate runtime state
- issue provider credentials
- trigger agent turns
- call Slack APIs
- read or return secret values
- expose raw authorization URLs
- expose OAuth tokens, API keys, private keys, or Authorization headers

Reporting data may include:

- health status
- service/version metadata
- configured plugin names
- skill names and owning plugin provider
- conversation and turn summaries when provided by an in-process, read-only Junior reporting interface
- expiring raw conversation transcripts, including tool calls/results, only for public conversations while session-log messages are still present
- redacted private-conversation transcript metadata, such as message roles, timestamps, sizes, and tool names
- Sentry conversation links for conversation summaries when Sentry DSN and org slug configuration are present
- trace IDs for turns when the runtime captured an active Sentry trace
- packaged content summary
- sanitized runtime paths only when explicitly needed by an authenticated dashboard view

Session reporting must not include conversation text, Pi messages, tool results, raw session-log payloads, or turn-session error messages.

Dashboard transcript and title redaction must follow `./data-redaction-policy.md`.

Public health responses must not include runtime discovery data such as cwd, home directory, plugin names, skill names, or packaged content.

## Nitro Integration

`juniorDashboardNitro()` mounts dashboard routes into the same Nitro deployment as `juniorNitro()`.

The dashboard Nitro module must:

1. Register only route-prefixed dashboard/auth handlers.
2. Avoid global middleware that can intercept Junior runtime routes.
3. Avoid changing `createApp()` runtime behavior.
4. Avoid requiring Junior to accept a dashboard plugin.
5. Register dashboard/auth routes with higher precedence than the existing Junior catch-all handler.
6. Work when mounted beside the existing Junior catch-all handler.

Apps should configure the dashboard explicitly:

```ts
export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({ plugins }),
    juniorDashboardNitro({
      authPath: "/api/auth",
      allowedGoogleDomains: ["sentry.io"],
    }),
  ],
});
```

## Failure Model

- Missing Better Auth secret, Google client config, trusted origin, or allowlist fails startup.
- Unauthenticated dashboard requests redirect to Google login or return `401` for JSON routes.
- Authenticated users outside the configured domain/email allowlist receive `403`.
- Better Auth callback failures return a non-secret error page.
- Reporting read failures return dashboard-scoped errors without leaking secrets.
- Stateless sessions cannot be selectively revoked. Global invalidation uses secret rotation or a future cookie-version mechanism.

## Security Invariants

1. Dashboard auth is path-scoped.
2. Dashboard auth must never wrap Slack webhooks, provider OAuth callbacks, sandbox egress, internal queue/resume/heartbeat routes, or `/health`.
3. Dashboard sessions do not grant provider credentials or Slack permissions.
4. Dashboard APIs never return secret-bearing runtime values.
5. Browser session cookies are never model-visible and never passed into sandbox execution.
6. The dashboard package is not a Junior plugin and is not exposed to agent turns.

## Observability

Dashboard auth and reporting should emit safe metadata only:

- auth success/failure reason category
- authorization denial reason category
- route family
- provider name (`google`)
- allowed-domain match as boolean

Logs and spans must not include:

- session cookie values
- OAuth state values
- ID tokens
- Google access tokens
- email addresses unless an existing privacy policy explicitly allows them

## Verification

Dashboard implementation requires integration tests for:

1. unauthenticated `GET /` starts the Better Auth login flow when the dashboard package is mounted.
2. `GET /health` returns public minimal health JSON.
3. the dashboard Nitro module does not register a catch-all route when mounted at `/`.
4. unauthenticated `GET /api/dashboard/info` does not return diagnostics.
5. authenticated allowed-domain users can read `/api/dashboard/info`.
6. authenticated wrong-domain users receive `403`.
7. `allowedEmails` admits a configured individual account.
8. `/api/info` no longer exposes public runtime diagnostics.
9. Slack webhook, provider OAuth callback, internal, and sandbox egress routes are not intercepted by dashboard auth.
10. dashboard reporting cannot return secret-bearing values.

Tests must follow `./testing.md`: route wiring and auth behavior belong in integration tests.

## Related Specs

- `./security-policy.md`
- `./oauth-flows.md`
- `./plugin-runtime.md`
- `./testing.md`
- `./integration-testing.md`
