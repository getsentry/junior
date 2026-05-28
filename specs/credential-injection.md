# Credential Injection Spec

## Metadata

- Created: 2026-02-26
- Last Edited: 2026-05-28

## Related

- [Security Policy](./security-policy.md)
- [OAuth Flows Spec](./oauth-flows.md)
- [Plugin Architecture Spec](./plugin.md)

## Purpose

Define how Junior maps registered plugin provider domains to host-managed credentials without exposing secrets or manual auth commands to the model.

## Core model

1. Plugin manifests own provider domains, credentials, command env, OAuth config, and runtime setup. See [Plugin Architecture Spec](./plugin.md).
2. Skills do not declare capabilities, config keys, credentials, provider domains, or runtime setup.
3. The agent runs the real provider command. Runtime authentication is implicit and host-owned.
4. The runtime resolves the provider from the outgoing request host, lazily issues a requester-bound provider lease, and applies credential headers to that forwarded request.
5. If auth is missing or stale, the proxy returns a command-readable auth-required response and the command failure path starts a private OAuth flow, then resumes the paused turn after authorization.

## Runtime contract

### Lease issuance

- Resolve provider from the Vercel Sandbox forwarded host for proxied sandbox egress.
- Require requester context before issuing provider credentials.
- Return short-lived leases only.
- Keep any host-side egress lease cache bounded by the signed requester/sandbox context expiry and lease expiry.

### Injection behavior

- Enablement happens when sandbox traffic reaches a registered provider domain, not at skill-load time.
- Delivery uses the Vercel Sandbox firewall request proxy for provider domains when available, with host-side header injection on the forwarded request.
- Plugin credentials may define a provider-specific `auth-token-placeholder` for CLI compatibility.
- Plugin manifests may define non-secret `command-env` values for CLI compatibility. These may include placeholder API keys, deployment defaults, or explicit public host env bindings, but never real secrets.
- Do not inject long-lived secrets into sandbox files.
- Credential issuance is intentionally lazy to avoid wasted token minting and provider compute for commands that never touch authenticated domains.
- Do not infer provider intent from bash commands, skill prose, or planned work to pre-scope tokens. Fine-grained token scopes are desirable, but guessing intent is not a safe authorization boundary; provider/domain matching at request time is the contract.

### Sandbox egress proxy

- New sandbox sessions use a Vercel Sandbox network policy that forwards declared credential provider domains to Junior's internal egress handler.
- The runtime configures the forwarding URL with a signed requester context bound to the sandbox VM session so the proxy can mint per-user OAuth leases lazily without a state-store lookup.
- The internal egress handler must verify the Vercel Sandbox OIDC token and signed requester/sandbox context before proxying.
- The egress route must reconstruct the upstream URL only from Vercel forwarded host/scheme/port/path headers. The proxy route URL contains Junior routing state and must not be used as the upstream path.
- The egress route must reject forwarded hosts that do not match a registered provider domain.
- The proxy must not use method/URL/body-only replay fingerprints as an authorization boundary because duplicate request shapes can be legitimate client retries.
- The proxy must strip hop-by-hop and proxy-control headers before sending the upstream request.
- Sandbox-supplied request headers and upstream response state may pass through once Vercel OIDC, requester context, and provider-domain ownership have been verified.

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

- Header transforms target the domains declared by the GitHub plugin manifest.
- The GitHub API host is the declared `api.github.com` or `api.*` domain, independent of manifest order.
- The built-in GitHub plugin declares `api.github.com` for REST API calls and
  `github.com` for git smart-HTTP.
- Runtime may reuse a short-lived sandbox egress lease for repeated GitHub commands in the same turn.
- Provider `401`/`403` responses discard the cached sandbox egress lease so resumed auth can mint from current provider state.

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

## Non-goals

- Skill-level capability allowlists.
- Model-visible auth-management commands.
- Provider-specific policy engines beyond requester and turn scoping.
- Using arbitrary skill prose as an authority source for runtime package installation, MCP setup, command env, or credential configuration.
