# Backfill `credential-injection`

## Why

Junior's credential model keeps provider secrets out of the model and sandbox while still allowing sandbox commands to reach authenticated provider APIs. The current contract spans plugin manifests, credential brokers, OAuth storage, GitHub App tokens, sandbox network policy, Vercel Sandbox firewall forwarding, OIDC verification, requester-context signing, and command-readable auth failures. A baseline OpenSpec capability is needed before the auth/plugin/security specs are consolidated.

## What Changes

- Add an OpenSpec capability for `credential-injection`.
- Specify broker leases, command environment placeholders, sandbox egress policy, forwarded request verification, provider/domain resolution, lazy requester-bound lease issuance, header injection, cache scoping, upstream auth rejection handling, provider profiles, and verification ownership.
- Record prior art from Vercel Sandbox firewall forwarding, Vercel Sandbox authentication, OAuth 2.0 refresh grants, and GitHub App installation tokens.
- Record open questions around wildcard domains, scheduled credential subjects, lease budgets, and broad `ok:false` auth markers.

## Impact

- Affected specs:
  - `security-policy`
  - `oauth-flows`
  - `plugin-manifest`
  - `plugin-runtime`
  - `sandbox-tools`
  - `scheduler`
  - `trusted-plugin-dispatch`
  - `instrumentation`
  - `testing`
- Affected code evidence:
  - `specs/credential-injection.md`
  - `packages/junior/src/chat/credentials/*`
  - `packages/junior/src/chat/plugins/auth/*`
  - `packages/junior/src/chat/sandbox/egress-*`
  - `packages/junior/src/handlers/sandbox-egress-proxy.ts`
  - `packages/junior/src/chat/capabilities/factory.ts`
- Affected verification:
  - Unit tests for brokers, OAuth token stores/scopes, header transforms, sandbox egress tokens, policy building, and proxy validation.
  - Integration tests for real plugin/broker/proxy wiring.
  - Evals for user-facing auth continuation and provider-command workflows.
