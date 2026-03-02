# Skill Capability and Credential Injection Spec

## Status

Draft

## Related

- [Security Policy](./security-policy.md)
- Provider Catalog: `src/chat/capabilities/catalog.ts`

## Purpose

Define a capability model where skills declare required capabilities and runtime enables short-lived provider credentials on demand via `jr-rpc issue-credential <capability>`, delivered through sandbox header transforms.

## Core model

1. Skill loads normally.
2. Runtime reads `requires-capabilities` from active skill.
3. Agent enables credential with bash custom command `jr-rpc issue-credential <capability>`.
4. Runtime issues short-lived credentials and applies sandbox header transforms.
5. Runtime does not persist long-lived secrets in sandbox env/files or skill files.

## Skill contract

Skills declare required capabilities in frontmatter.

```yaml
---
name: github
description: Create and update GitHub issues.
requires-capabilities: github.issues.read github.issues.write
---
```

Rules:

- `requires-capabilities` is optional.
- Value is a whitespace-delimited token list.
- Tokens must match `^[a-z0-9]+(\.[a-z0-9-]+)+$`.
- Skills must never include secret values.

## Runtime contract

### Capability resolution

- Resolve capabilities from active skill context for guidance and observability.
- Declarations are currently soft-enforced (warn-only) when missing/mismatched.

### Credential issuance

- Use provider-specific broker implementations.
- Return short-lived leases only.
- Keep lease reuse in memory only.

### Injection behavior

- Enablement happens on explicit `jr-rpc issue-credential` bash custom command, not at skill-load time.
- Delivery uses sandbox header transforms for matching domains.
- Do not inject privileged credentials into sandbox env vars.
- Do not write long-lived credentials into sandbox files.

### Capability caching

- Runtime may reuse in-memory lease state for repeated issue-credential calls in the same active context.

## GitHub profile

### Capabilities

- `github.issues.read`
- `github.issues.write`
- `github.issues.comment`
- `github.labels.write`

### Issuance flow

1. Host runtime signs a GitHub App JWT using `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
2. Runtime exchanges JWT for installation token using required `GITHUB_INSTALLATION_ID`.
3. Runtime applies `Authorization` header transform for `api.github.com`.

### Lease behavior

- Prefer short-lived token leases.
- Runtime cache can reuse a lease in memory.
- Current cap: at most 1 hour lease window.

## Sentry profile

### Capabilities

- `sentry.api`

### Issuance flow

1. Broker checks for per-user OAuth token (stored by Slack user ID via `UserTokenStore`).
2. If stored token is near expiry, refreshes via Sentry token endpoint (`grant_type=refresh_token`).
3. Falls back to static `SENTRY_AUTH_TOKEN` env var for dev/testing/CI.
4. Runtime applies `Authorization` header transform for `sentry.io`.
5. Lease env includes `SENTRY_AUTH_TOKEN` for CLI consumption.

### OAuth authorization code flow

- Auth initiated by `/sentry auth` command.
- Uses Authorization Code Grant (RFC 6749 §4.1) via `jr-rpc oauth-start sentry`.
- Callback handler at `/api/oauth/callback/sentry` exchanges code for tokens server-side.
- Tokens stored per Slack user ID via `StateAdapterTokenStore` (Redis-backed).
- Agent never sees token values — only receives `authorize_url` to post to the user.
- Requires `SENTRY_CLIENT_ID` and `SENTRY_CLIENT_SECRET` on host.
- See [OAuth Flows Spec](./oauth-flows.md) for full flow details.

### Lease behavior

- Prefer short-lived token leases.
- Current cap: at most 1 hour lease window (or remaining token TTL, whichever is shorter).
- Per-user tokens refreshed when within 5 minutes of expiry.

## Observability

Emit events without secret material:

- `credential_issue_request`
- `credential_issue_success`
- `credential_issue_failed`
- `capability_not_declared_for_skill` (warn-only)
- `credential_inject_start`
- `credential_inject_cleanup`

## Non-goals

- External policy/config systems for capability allowlists.
- Multi-provider policy engines.

## Backward compatibility

- Skills without `requires-capabilities` continue to work unchanged.
