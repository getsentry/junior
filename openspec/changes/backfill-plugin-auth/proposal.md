# Backfill `plugin-auth`

## Why

Plugin auth brokers turn manifest credential declarations into host-managed credential leases. They decide how OAuth bearer tokens, static API headers, GitHub App installation tokens, command-env placeholders, domain header transforms, token refresh, and scope checks behave. Today this is implemented in broker modules and tests, while related specs cover manifests, OAuth UX, credential injection, and sandbox egress.

This backfill creates a focused OpenSpec capability for broker behavior and provider credential patterns.

## What

- Backfill an OpenSpec capability for `plugin-auth`.
- Inventory plugin auth brokers, token request helpers, scope helpers, registry broker routing, user token store usage, and tests.
- Define normative requirements for:
  - credential lease shape and secrecy
  - API header broker behavior
  - OAuth bearer broker behavior
  - OAuth token refresh and scope enforcement
  - OAuth token request/response handling
  - GitHub App broker behavior
  - GitHub App permission derivation
  - plugin command env projection
  - broker failure semantics
  - verification taxonomy
- Record undefined behavior around static fallback policy, token refresh retry, GitHub App token caching, provider-specific permission mapping, and literal header safety.

## Impact

- Canonical capability: `plugin-auth`
- Related capabilities:
  - `plugin-manifest`
  - `plugin-runtime`
  - `credential-injection`
  - `oauth-flows`
  - `security-policy`
  - `provider-packages`

## Non-Goals

- Manifest field syntax and validation.
- OAuth authorization link delivery and callback resume UX.
- Sandbox egress proxy implementation.
- Provider-specific API workflows beyond credential issuance.
- Changing broker behavior.
