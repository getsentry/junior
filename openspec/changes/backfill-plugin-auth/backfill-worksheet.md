# Backfill Worksheet: `plugin-auth`

## Scope

- Capability: Plugin auth
- Change: `backfill-plugin-auth`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/plugin-auth/spec.md` after review, with cross-links from plugin/runtime/auth prose specs

## Current-Source Inventory

### Existing Specs And Policies

- `specs/credential-injection.md`: requester-bound credential leases, sandbox egress proxy, and secret handling.
- `specs/oauth-flows.md`: OAuth authorization start/callback/resume lifecycle.
- `specs/plugin-manifest.md`: credential/API header/OAuth declaration syntax.
- `specs/plugin-runtime.md`: broker creation routing.
- `specs/security-policy.md`: token and sandbox secrecy.
- `specs/testing.md`: verification layer ownership.

### Code Paths

- `packages/junior/src/chat/plugins/auth/api-headers-broker.ts`: API-header-only broker and header env resolution.
- `packages/junior/src/chat/plugins/auth/oauth-bearer-broker.ts`: OAuth/static bearer broker, token refresh, requester token lookup, scope enforcement.
- `packages/junior/src/chat/plugins/auth/github-app-broker.ts`: GitHub App JWT signing, installation token issuance, domain auth-mode handling, permission derivation.
- `packages/junior/src/chat/plugins/auth/oauth-request.ts`: token request construction and token response parsing.
- `packages/junior/src/chat/plugins/auth/auth-token-placeholder.ts`: non-secret sandbox token placeholders.
- `packages/junior/src/chat/plugins/command-env.ts`: command-env placeholder resolution.
- `packages/junior/src/chat/credentials/broker.ts`: `CredentialBroker`, `CredentialLease`, `CredentialUnavailableError`.
- `packages/junior/src/chat/credentials/header-transforms.ts`: transform merging.
- `packages/junior/src/chat/credentials/oauth-scope.ts`: scope normalization and comparison.
- `packages/junior/src/chat/credentials/user-token-store.ts`: requester token storage interface.
- `packages/junior/src/chat/plugins/registry.ts`: broker creation routing.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/plugins/api-headers-broker.test.ts`
  - `packages/junior/tests/unit/plugins/sentry-broker.test.ts`
  - `packages/junior/tests/unit/plugins/github-app-broker.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-registry.test.ts`
  - `packages/junior/tests/unit/plugins/plugin-registry-packages.test.ts`
- Integration:
  - `packages/junior/tests/integration/sandbox-egress-proxy.test.ts`
  - `packages/junior/tests/integration/oauth-callback-slack.test.ts`
  - `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
- Evals:
  - OAuth/provider workflow evals that require auth prompts or successful provider commands.

## Prior Art

- OAuth 2.0 refresh token grants let a confidential client obtain new access tokens from the token endpoint without another user interaction.
- OAuth scopes represent an authorization grant contract; a refreshed or stored token that lacks required scopes must be treated as insufficient.
- GitHub Apps authenticate with an app JWT and request short-lived installation access tokens for a specific installation; permission scopes can be narrowed when creating installation tokens.
- API-key/header auth systems typically keep actual secrets in deployment configuration and inject them at the HTTP boundary.

Sources:

- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- GitHub App installation authentication: https://docs.github.com/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

## Implemented Behavior

- Behavior that code currently enforces:
  - Leases include unique id, provider, env, header transforms, ISO expiry, and reason metadata.
  - Token-backed leases put placeholders in command env and real tokens in host-managed header transforms.
  - API-header broker resolves `${VAR}` placeholders from host env at issue time and fails if missing.
  - OAuth bearer broker uses requester stored tokens when requester id and OAuth config are present.
  - Stored OAuth tokens must be unexpired and include required scope.
  - Near-expiry OAuth tokens refresh with `grant_type=refresh_token`.
  - Successful refresh persists access token, refresh token, expiry, and scope.
  - Refresh failure can fall back to the still-valid old token; expired refresh failures become unavailable credentials.
  - Static auth-token env fallback works for providers without OAuth and for non-requester-bound OAuth-capable issuance.
  - OAuth token requests support body or Basic client authentication and form or JSON payload serialization.
  - OAuth token parsing requires non-empty access and refresh tokens and positive numeric `expires_in` when present.
  - GitHub App broker signs RS256 JWTs, accepts raw/quoted/escaped/base64 PEM private keys, exchanges for installation tokens, and chooses Bearer vs Basic git auth by domain.
  - GitHub App broker derives permission payload from `github.<scope>.<read|write>` capabilities for known scopes.
  - Broker routing is selected by plugin runtime from manifest credentials/API headers.
- Behavior that tests currently verify:
  - API-header env resolution and missing env failure.
  - OAuth bearer requester token lease shape, static fallback, merged plugin-level API headers, unavailable credentials, refresh, and scope mismatch.
  - GitHub App lease shape, placeholder override, configured domains, service domains, domain ordering, fresh token per issue, and capability-derived permissions.
- Behavior that appears accidental or weakly enforced:
  - OAuth token request/response helper behavior lacks direct test coverage.
  - Static env fallback is accepted even when OAuth config exists and no requester id is supplied.
  - GitHub App installation tokens are not cached.
  - Capability-to-permission mapping is hardcoded and may lag provider packages.
  - Literal API headers are passed through when manifest validation accepts them.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Brokers keep secrets host-side and issue only placeholders to sandbox env.
  - Requester-scoped OAuth tokens take precedence for requester-bound work.
  - Insufficient scopes require reauthorization.
  - Host misconfiguration fails loudly rather than creating fake leases.
  - Provider-specific brokers may mint short-lived provider tokens but should return the shared `CredentialLease` shape.
- Behavior that should remain implementation detail:
  - Exact lease id format.
  - Exact maximum lease duration and refresh buffer values.
  - Exact GitHub JWT clock skew.
  - Exact error text except where tests assert user-relevant behavior.
- Behavior that should be non-goal:
  - OAuth authorization link delivery.
  - OAuth callback token storage.
  - Egress proxy request rewriting.
  - Provider API command behavior.

## Undefined Behavior / Open Questions

| Question                                                             | Evidence                                       | Options                                                                   | Recommendation                                                                   | Status |
| -------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| Should static token fallback be allowed for OAuth-capable providers? | Broker uses env fallback when no requester id. | Keep, disable in production, or require explicit manifest flag.           | Require explicit policy before enforcing requester-bound credentials everywhere. | open   |
| Should OAuth helpers have direct unit tests?                         | No `oauth-request` test file found.            | Add direct tests or rely on broker tests.                                 | Add direct tests because serialization/parsing is deterministic.                 | open   |
| Should GitHub App tokens be cached?                                  | Broker mints fresh token every issue.          | Keep fresh, cache until expiry, or cache per installation/permission set. | Keep fresh until rate/cost issues appear.                                        | open   |
| How should GitHub permission mapping stay current?                   | Hardcoded `KNOWN_SCOPES`.                      | Provider package tests, generated docs sync, or runtime validation.       | Provider package spec should own capability map coverage.                        | open   |
| Should literal static API headers be allowed?                        | API-header broker passes literals through.     | Allow non-secret literals, require env refs, or classify by header.       | Resolve in manifest/security policy.                                             | open   |

## OpenSpec Requirements Draft

| Requirement                        | Scenarios                                                        | Source Evidence              | Notes                               |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| Credential lease secrecy and shape | success, placeholders, command env, max expiry                   | broker code/tests            | Host-managed secrets.               |
| API header broker                  | env present, missing, static, no transforms                      | api-header broker tests      | Literal policy open.                |
| OAuth bearer broker                | requester token, missing, expired, scope, static fallback        | sentry broker tests          | Auth UX elsewhere.                  |
| OAuth token refresh                | near expiry, success, fallback scope, refresh fail valid/expired | broker tests/code            | Helper tests missing.               |
| OAuth token request/response       | body/basic, JSON, unsupported, missing fields, invalid expiry    | oauth-request code           | Direct tests gap.                   |
| OAuth scope comparison             | contains, empty required, empty stored                           | oauth-scope code             | Unit tests can be added.            |
| GitHub App broker                  | env/private key, API domain, token, domain auth modes            | github app broker tests      | GitHub docs.                        |
| GitHub App permission derivation   | no caps, read/write, invalid                                     | github app broker tests/code | Mapping gap.                        |
| Plugin auth failure semantics      | unavailable vs malformed                                         | broker code/tests            | Orchestration consumes unavailable. |
| Verification taxonomy              | unit, integration, eval                                          | testing spec                 | Layer map.                          |

## Migration Notes

- Canonical spec updates:
  - Add `plugin-auth` as a dedicated OpenSpec capability.
  - Cross-link from `plugin-runtime` broker creation, `credential-injection` leases, and `oauth-flows` authorization UX.
- Index/pointer updates:
  - Add `plugin-auth` to spec index/root known specs after acceptance.
- Superseded content:
  - Keep manifest syntax in `plugin-manifest`.
  - Keep OAuth callback/resume in `oauth-flows`.
  - Keep egress proxy injection in `credential-injection`.
- Test/eval taxonomy changes:
  - Add direct unit tests for OAuth request/response helpers when behavior changes.
  - Keep provider workflow evals focused on user-visible auth success/failure.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-plugin-auth' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: static fallback policy, OAuth helper direct tests, GitHub token caching, GitHub permission map coverage, literal header policy.
