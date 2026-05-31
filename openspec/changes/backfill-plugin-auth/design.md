# Design: `plugin-auth` Baseline Backfill

## Sources Reviewed

- `specs/credential-injection.md`
- `specs/oauth-flows.md`
- `specs/plugin-manifest.md`
- `specs/plugin-runtime.md`
- `packages/junior/src/chat/plugins/auth/api-headers-broker.ts`
- `packages/junior/src/chat/plugins/auth/oauth-bearer-broker.ts`
- `packages/junior/src/chat/plugins/auth/github-app-broker.ts`
- `packages/junior/src/chat/plugins/auth/oauth-request.ts`
- `packages/junior/src/chat/plugins/auth/auth-token-placeholder.ts`
- `packages/junior/src/chat/plugins/command-env.ts`
- `packages/junior/src/chat/credentials/broker.ts`
- `packages/junior/src/chat/credentials/header-transforms.ts`
- `packages/junior/src/chat/credentials/oauth-scope.ts`
- `packages/junior/src/chat/credentials/user-token-store.ts`
- `packages/junior/tests/unit/plugins/api-headers-broker.test.ts`
- `packages/junior/tests/unit/plugins/sentry-broker.test.ts`
- `packages/junior/tests/unit/plugins/github-app-broker.test.ts`
- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- GitHub App installation authentication docs: https://docs.github.com/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

## Prior-Art Interpretation

- OAuth refresh-token behavior is server-side runtime behavior. The broker can refresh access tokens using stored refresh tokens and client credentials; the model and sandbox only see non-secret placeholders and host-injected headers.
- OAuth scopes are part of the grant contract. Stored grants that no longer satisfy the manifest-required scope must be treated as unavailable so the authorization UX can reauthorize.
- GitHub Apps authenticate as the app, then exchange for an installation token scoped to installation permissions. Junior's GitHub App broker maps manifest capabilities to GitHub installation token permissions where possible.
- API-header credentials are host-managed deployment secrets. They should resolve from host environment at lease issuance, not from model-visible text.

## Design Decisions

### Broker Leases Are Host-Managed

All plugin brokers return `CredentialLease` objects containing provider identity, non-secret command env placeholders, domain-scoped header transforms, expiry, and metadata. Real secret values live in header transforms consumed by host egress code and must not be copied into sandbox env.

### OAuth Bearer Prefers Requester Tokens

When a requester id is available and the provider has OAuth config, the broker uses requester-scoped stored tokens. Static env-token fallback remains for providers without OAuth config and for non-requester-bound runs, but should be reviewed as a deployment policy.

### Refresh Before Expiry

Stored OAuth tokens within a refresh buffer are refreshed before lease issuance. If refresh fails but the old token is still valid, the broker may issue a lease with the old token; if it is expired, credentials are unavailable.

### GitHub App Tokens Are Minted Per Issue

The current broker mints a fresh installation token for each lease issue. It does not cache installation tokens. That is simple and avoids cross-requester state but may be optimized later.

### Broker Routing Lives In Plugin Runtime

`plugin-auth` defines broker behavior once a broker is selected. `plugin-runtime` owns selecting API-header, OAuth bearer, or GitHub App broker from manifest declarations.

## Risks

- Static env-token fallback can blur requester-bound credential guarantees if used in production for user-scoped providers.
- OAuth token request/response helpers currently have limited direct unit coverage.
- GitHub capability-to-permission mapping is provider-specific and partial.
- Literal static header policy is mostly manifest/security policy, but broker behavior will honor manifest output as written.

## Verification Approach

- Unit tests own broker lease shape, env/header resolution, missing credential errors, token refresh, scope checks, GitHub App JWT/token request behavior, and permission mapping.
- Integration tests own broker consumption through credential injection and sandbox egress.
- Evals own user-visible reauthorization or provider workflow success, not broker internals.
