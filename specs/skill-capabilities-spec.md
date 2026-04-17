# Skill Capability and Credential Injection Spec

## Metadata

- Created: 2026-02-26
- Last Edited: 2026-04-17

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Updated repo-root file paths and aligned OAuth URL visibility contract with security policy.
- 2026-03-20: Documented prompt exposure of declared capabilities and clarified Sentry OAuth initiation paths.
- 2026-04-17: Removed skill-level capability declarations and explicit model-facing auth commands in favor of plugin-owned permission manifests plus runtime-owned implicit auth.

## Status

Draft

## Related

- [Security Policy](./security-policy.md)
- [OAuth Flows Spec](./oauth-flows-spec.md)
- Provider Catalog: `packages/junior/src/chat/capabilities/catalog.ts`

## Purpose

Define how Junior maps a loaded plugin-backed skill to host-managed credentials without exposing secrets or manual auth commands to the model.

## Core model

1. Plugins own provider permissions in `plugin.yaml`.
2. Skills may declare `uses-config` keys, but they do not declare capabilities.
3. After a plugin-backed skill is loaded, the agent runs the real provider command.
4. The runtime resolves the provider from the active skill, issues a provider lease, and injects credentials for the current turn only.
5. If auth is missing or stale, the runtime starts a private OAuth flow and resumes the paused turn after authorization.

## Plugin contract

Plugins define:

- `capabilities`: host-side permission manifest for the provider integration
- `credentials`: how runtime leases are delivered to tools
- `oauth`: optional per-user OAuth configuration
- `target`: optional provider-default metadata such as a repo config key

Capabilities remain a host-side permission description. They are not a model-facing command surface.

## Skill contract

Plugin-backed skills may declare:

```yaml
---
name: github
description: Create and update GitHub issues.
uses-config: github.repo
---
```

Rules:

- `uses-config` is optional.
- `requires-capabilities` is no longer supported.
- Skills must never include secret values.
- Skills should keep provider defaults explicit so repo/project commands stay deterministic.

## Runtime contract

### Lease issuance

- Resolve provider from `activeSkill.pluginProvider`.
- Require requester context before issuing provider credentials.
- Return short-lived leases only.
- Keep lease reuse in memory only, keyed by provider for the active turn.

### Injection behavior

- Enablement happens when the authenticated provider command runs, not at skill-load time.
- Delivery uses sandbox header transforms for matching domains.
- Plugin credentials may define a provider-specific `auth-token-placeholder` for CLI compatibility.
- Do not inject long-lived secrets into sandbox files.

### Security goals

- Secrets are hidden from the model and sandbox filesystem.
- Credentials are requester-bound.
- Leases are valid only for the active turn.
- Provider defaults may guide command construction, but credential availability is still provider-level and turn-bound.

## GitHub profile

### Permission model

- Plugin manifest capabilities map to GitHub App installation permissions.
- Runtime requests the full permission set declared by the GitHub plugin manifest.
- Repo context is still important for command correctness, but credential issuance is provider-level and turn-bound.

### Lease behavior

- Header transforms target `api.github.com`.
- If repo contents access is declared, runtime also injects auth for `github.com` git smart-HTTP.
- Runtime cache may reuse a lease in memory for repeated GitHub commands in the same turn.

## Sentry profile

### Permission model

- The Sentry plugin currently declares a single host-side capability: `sentry.api`.
- Runtime still treats issuance as provider-level, not command-level.

### OAuth behavior

- `OAuthBearerBroker` checks for a per-user OAuth token stored by requester ID.
- If the token is near expiry, runtime refreshes it server-side.
- Missing or stale auth triggers the private OAuth resume flow defined in the OAuth Flows Spec.

## Observability

Emit events without secret material:

- `credential_issue_request`
- `credential_issue_success`
- `credential_issue_failed`
- `credential_inject_start`

## Non-goals

- Skill-level capability allowlists.
- Model-visible auth-management commands.
- Provider-specific policy engines beyond requester and turn scoping.

## Backward compatibility

- Plugin-backed skills must migrate off `requires-capabilities`.
- Authenticated provider work should run the real provider command and let the runtime handle auth implicitly.
