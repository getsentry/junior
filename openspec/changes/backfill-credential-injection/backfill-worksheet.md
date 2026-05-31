# Backfill Worksheet: `credential-injection`

## Scope

- Capability: Credential injection
- Change: `backfill-credential-injection`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/credential-injection.md` plus `openspec/specs/credential-injection/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/credential-injection.md`: existing credential injection prose contract.
- `specs/security-policy.md`: secret handling, requester-bound leases, Vercel Sandbox egress verification, GitHub/Sentry credential policy.
- `specs/oauth-flows.md`: user token storage, OAuth callback, auth resume, and missing auth behavior.
- `specs/plugin-manifest.md`: credential domains, auth token env, command env, and API header validation.
- `specs/plugin-runtime.md`: broker creation and plugin capability catalog.
- `specs/sandbox-tools.md`: sandbox runtime and command execution boundaries.
- `specs/scheduler.md`: delegated credential subjects and non-interactive auth constraints.
- `specs/testing.md` and `specs/eval-testing.md`: verification layer boundaries.

### Code Paths

- `packages/junior/src/chat/credentials/broker.ts`: `CredentialBroker`, `CredentialLease`, header transforms, and unavailable error.
- `packages/junior/src/chat/credentials/header-transforms.ts`: per-domain header transform merging.
- `packages/junior/src/chat/credentials/oauth-scope.ts`: OAuth scope normalization and required-scope check.
- `packages/junior/src/chat/credentials/state-adapter-token-store.ts`: per-user provider token storage and TTL.
- `packages/junior/src/chat/plugins/auth/api-headers-broker.ts`: deployment-env API header transforms.
- `packages/junior/src/chat/plugins/auth/oauth-bearer-broker.ts`: per-user OAuth token lease issuance, refresh, static fallback, placeholders, and API header merging.
- `packages/junior/src/chat/plugins/auth/github-app-broker.ts`: GitHub App JWT signing, installation token exchange, permission mapping, REST/git auth transforms, and placeholders.
- `packages/junior/src/chat/sandbox/egress-policy.ts`: provider domain discovery, network policy, proxy URL, and command env placeholders.
- `packages/junior/src/chat/sandbox/egress-session.ts`: signed requester context token and cached lease storage.
- `packages/junior/src/chat/sandbox/egress-oidc.ts`: Vercel Sandbox OIDC verification and discovery cache.
- `packages/junior/src/chat/sandbox/egress-proxy.ts`: forwarded request validation, provider resolution, lazy lease issuance, header injection, upstream forwarding, auth rejection cache clearing, and auth-required response.
- `packages/junior/src/handlers/sandbox-egress-proxy.ts`: HTTP handler boundary.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/plugins/sentry-broker.test.ts`
  - `packages/junior/tests/unit/plugins/github-app-broker.test.ts`
  - `packages/junior/tests/unit/plugins/api-headers-broker.test.ts`
  - `packages/junior/tests/unit/state/state-adapter-token-store.test.ts`
  - `packages/junior/tests/unit/config/credentials-matrix.test.ts`
  - `packages/junior/tests/unit/misc/sandbox-credentials.test.ts`
  - `packages/junior/tests/unit/handlers/sandbox-egress-proxy.test.ts`
  - `packages/junior/tests/unit/capabilities/capability-router.test.ts`
  - plugin manifest credential/API header validation tests.
- Integration:
  - `packages/junior/tests/integration/sandbox-egress-proxy.test.ts`
  - scheduler/trusted dispatch credential-subject integration tests.
- Evals:
  - Provider workflow evals under `packages/junior-evals/evals/github` and `packages/junior-evals/evals/sentry`.
  - Auth/resume eval fixtures that seed credential providers.

## Prior Art

- Vercel Sandbox firewall supports user-defined domain allow rules and request forwarding through `forwardURL`.
- Vercel Sandbox forwarded requests include original host/scheme/port details and a Vercel-issued OIDC token that identifies the source sandbox.
- Vercel Sandbox SDK prefers OIDC auth and supports explicit Vercel access token, team id, and project id fallback for non-Vercel environments.
- OAuth 2.0 refresh grants let a server-side client exchange a refresh token for a fresh access token without exposing credentials to the resource owner agent.
- GitHub App installation access tokens are short-lived provider tokens issued from host-side app credentials and may include requested permissions.

Sources:

- Vercel Sandbox firewall: https://vercel.com/docs/vercel-sandbox/concepts/firewall/
- Vercel Sandbox firewall request proxying: https://vercel.com/changelog/vercel-sandbox-firewall-now-supports-request-proxying-and-filtering
- Vercel Sandbox authentication: https://vercel.com/docs/vercel-sandbox/concepts/authentication
- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- GitHub App installation authentication: https://docs.github.com/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

## Implemented Behavior

- Behavior that code currently enforces:
  - Credential leases include provider, env, header transforms, expiry, and metadata.
  - OAuth bearer leases prefer requester-bound stored OAuth tokens, refresh near-expiry tokens, enforce required scope, and use placeholder env values in sandbox.
  - OAuth bearer broker can fall back to static env token when no OAuth flow is configured or no requester path is available.
  - GitHub App leases sign a JWT, request installation access tokens, map plugin capabilities to installation permissions, distinguish REST bearer auth from git smart-HTTP Basic auth, and cap expiry.
  - API header broker resolves secret deployment env vars only on the host into header transforms.
  - Sandbox command env includes non-secret command env plus credential placeholders for registered providers.
  - Sandbox network policy forwards exact registered provider domains to `/api/internal/sandbox-egress[/<requesterToken>]`.
  - Requester context tokens are HMAC signed with `JUNIOR_SECRET`; Slack signing secret is not reused.
  - Egress proxy verifies Vercel Sandbox OIDC before credential issuance, requires a matching signed requester context, reconstructs upstream URL from forwarded headers, requires HTTPS, resolves provider by forwarded host, strips hop-by-hop/proxy-only headers, applies credential transforms host-side, returns upstream response, and clears cached leases after 401/403.
  - Cached egress leases are scoped by provider, requester id, egress id, and context id, with TTL bounded by lease and requester context expiry.
  - Missing provider credentials return a command-readable `junior-auth-required provider=<provider>` text response without auth URLs or tokens.
- Behavior that tests currently verify:
  - Broker lease shape, placeholders, static fallback, token refresh, scope mismatch, GitHub domain/auth-mode behavior, and fresh token issuance.
  - Sandbox policy construction, command env, requester token signing, OIDC/routing validation, requester/context cache isolation, auth rejection cache clearing, header stripping/injection, auth-required marker, and exact-domain behavior.
  - Integration wiring from plugin fixture through broker and egress proxy.
- Behavior that appears accidental or weakly enforced:
  - Exact-domain matching is strict; wildcard/subdomain policy is not specified beyond current tests.
  - Static token fallback may be acceptable in local/dev/test but needs a production/requester-bound policy decision.
  - Command-readable auth marker is text rather than a typed protocol error.
  - Lease max duration is hard-coded per broker.
  - Provider lease metadata allowed fields are not centrally constrained.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Credentials are host-managed and requester-bound for user-owned provider access.
  - Real secrets never enter model-visible context, sandbox env/files/args, skill text, or logs.
  - Provider domain matching is the credential authority.
  - Credential issuance is lazy, request-time, short-lived, and cache-bounded.
  - Auth missing becomes a private auth/resume workflow through OAuth specs.
- Behavior that should remain implementation detail:
  - Exact UUID format for lease ids and context ids.
  - Exact max lease duration unless product fixes it.
  - Exact log event names and span attributes.
  - Exact Vercel SDK auth fallback internals.
- Behavior that should be non-goal:
  - Skill-level capability allowlists.
  - Model-visible credential commands.
  - Injecting provider secrets into sandbox process environment.
  - Guessing credential scopes from bash commands or natural-language intent.

## Undefined Behavior / Open Questions

| Question                                                                         | Evidence                                                                                               | Options                                                                         | Recommendation                                                  | Status |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------ |
| Should registered domains support wildcards or subdomains?                       | Current matching is exact; Vercel policy supports more complex domain controls.                        | Exact only, explicit wildcard syntax, or provider-specific matching.            | Keep exact until manifest policy is expanded.                   | open   |
| Should static env token fallback be allowed in production requester-bound turns? | OAuth broker falls back when env token exists; security policy emphasizes requester-bound credentials. | Dev/test only, non-requester only, or provider opt-in.                          | Clarify in auth/plugin policy.                                  | open   |
| Should auth-required marker be typed?                                            | Current proxy returns text marker consumed by command failure path.                                    | Keep text, JSON envelope, or tool error.                                        | Keep until command failure parser is spec'd.                    | open   |
| How do scheduled credential subjects compose with requester-bound leases?        | Scheduler has explicit credential subject exception.                                                   | Reuse requesterId field, add credentialSubject field, or separate broker input. | Specify in scheduler/trusted dispatch consolidation.            | open   |
| Should lease metadata be allowlisted?                                            | Brokers include reason/installationId; metadata type allows arbitrary strings.                         | Allow any strings, provider-specific schema, or central allowlist.              | Add central safe metadata policy if telemetry leaks risk grows. | open   |

## OpenSpec Requirements Draft

| Requirement                                | Scenarios                                                           | Source Evidence                  | Notes                 |
| ------------------------------------------ | ------------------------------------------------------------------- | -------------------------------- | --------------------- |
| Credential broker lease contract           | lease, unavailable, expiry, merge                                   | broker/brokers/tests             | Shared interface.     |
| Non-secret sandbox command environment     | command env, placeholders, host env, secret rejection               | egress-policy, manifest tests    | Manifest-owned.       |
| Sandbox egress forwarding policy           | no domains, domains, requester token, missing base URL              | egress-policy/tests, Vercel docs | Lazy forwarding.      |
| Signed requester egress context            | create, missing secret, invalid, mismatch                           | egress-session/tests             | Security boundary.    |
| Vercel Sandbox egress request verification | OIDC, sandbox id, routing, HTTPS                                    | egress-proxy/tests, Vercel docs  | Verify before issue.  |
| Provider-domain resolution                 | match, unregistered, missing transform                              | egress-policy/proxy/tests        | Exact-domain current. |
| Lazy issuance and caching                  | no cache, cache, requester isolation, context isolation, transforms | egress-proxy/session/tests       | Cache scope.          |
| Proxy forwarding                           | URL, headers, bodyless, response, decoded headers, 401/403          | egress-proxy/tests               | Host-side injection.  |
| Auth-required proxy response               | unavailable, no secrets                                             | egress-proxy/tests               | OAuth cross-spec.     |
| OAuth bearer profile                       | valid, refresh, scope mismatch, missing token                       | oauth broker/tests, RFC 6749     | Sentry profile.       |
| GitHub App profile                         | lease, permissions, API domain, git/basic, service/bearer           | github broker/tests, GitHub docs | GitHub profile.       |
| Verification taxonomy                      | unit, integration, eval                                             | testing/eval specs               | Layer map.            |

## Migration Notes

- Canonical spec updates:
  - Existing `specs/credential-injection.md` is already canonical prose; after review, consolidate with this OpenSpec capability.
  - Cross-link strict domain matching to `plugin-manifest`.
  - Cross-link auth-required response handling to `oauth-flows` and session resumability.
- Index/pointer updates:
  - Already listed in `specs/index.md` and root `AGENTS.md`; add OpenSpec capability pointer after acceptance.
- Superseded content:
  - Keep provider-specific rationale in concise profiles; move repeated security policy text to cross-links.
- Test/eval taxonomy changes:
  - Keep broker/proxy invariants in unit tests.
  - Keep fixture plugin-to-proxy wiring in integration tests.
  - Keep user-visible auth resume and provider command success in evals/integration owned with auth specs.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-credential-injection' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: wildcard/subdomain policy, production static-token fallback, typed auth-required marker, scheduled credential subject composition, and lease metadata allowlisting.
