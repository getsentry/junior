# Skill Capability and Credential Injection Spec

## Metadata

- Created: 2026-02-26
- Last Edited: 2026-05-21

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-04: Updated repo-root file paths and aligned OAuth URL visibility contract with security policy.
- 2026-03-20: Documented prompt exposure of declared capabilities and clarified Sentry OAuth initiation paths.
- 2026-04-17: Removed skill-level capability declarations and explicit model-facing auth commands in favor of plugin-owned permission manifests plus runtime-owned implicit auth.
- 2026-04-26: Added the plugin-owned runtime setup boundary for packages, MCP endpoints, OAuth, and credentials.
- 2026-05-08: Added plugin-owned `command-env` as a non-secret CLI compatibility surface.
- 2026-05-12: Added Vercel Sandbox egress proxy activation for request-time credential issuance.
- 2026-05-13: Removed the old per-turn credential runtime in favor of egress proxy-only credential activation.
- 2026-05-21: Clarified lazy sandbox egress auth: signed requester/sandbox context in the forwarding URL, request-time provider resolution, and no intent guessing.

## Status

Draft

## Related

- [Security Policy](./security-policy.md)
- [OAuth Flows Spec](./oauth-flows-spec.md)
- Provider Catalog: `packages/junior/src/chat/capabilities/catalog.ts`

## Purpose

Define how Junior maps registered plugin provider domains to host-managed credentials without exposing secrets or manual auth commands to the model.

## Core model

1. Plugins own provider permissions in `plugin.yaml`.
2. Skills do not declare capabilities or config keys.
3. Registered providers are always available to sandbox commands.
4. The agent runs the real provider command.
5. The runtime resolves the provider from the outgoing request host, lazily issues a requester-bound provider lease, and injects credentials for that forwarded request.
6. If auth is missing or stale, the proxy returns a command-readable auth-required response and the command failure path starts a private OAuth flow, then resumes the paused turn after authorization.
7. Plugin manifests own runtime setup. Skills do not instruct the agent to install packages, bootstrap CLIs, configure provider credentials, command env, or MCP servers.

## Plugin contract

Plugins define:

- `capabilities`: host-side permission manifest for the provider integration
- `credentials`: how runtime leases are delivered to tools
- `command-env`: non-secret env vars or placeholders needed by sandbox commands
- `oauth`: optional per-user OAuth configuration
- `target`: optional provider-default metadata such as a repo config key

Capabilities remain a host-side permission description. They are not a model-facing command surface.

## Skill contract

Plugin-backed skills may declare normal skill metadata:

```yaml
---
name: github
description: Create and update GitHub issues.
---
```

Rules:

- `uses-config` is no longer supported. Config keys are owned by the parent plugin manifest and exposed through the provider catalog.
- `requires-capabilities` is no longer supported.
- Skills must never include secret values.
- Skills should use provider defaults from the runtime provider catalog so repo/project commands stay deterministic.
- Skills must treat plugin-provided commands, tools, and command env as already available. Missing CLIs, missing MCP tools, sandbox package failures, missing command env, or missing credentials are runtime/plugin setup failures to report or reconnect through runtime-owned flows, not problems for the skill to repair with package-manager or credential setup commands.

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

### Runtime setup boundary

- Loaded plugin-backed skills include a host-owned boundary derived from the plugin manifest before the skill body.
- `loadSkill` re-resolves plugin ownership from the skill path, rejects mismatched plugin metadata, and builds loaded metadata from the current `SKILL.md` frontmatter.
- Turn checkpoints persist loaded skill names for MCP resume; sandbox credential availability comes from registered providers, not checkpointed active-provider state.
- CLI and system packages belong in `plugin.yaml` `runtime-dependencies`.
- Postinstall/bootstrap commands belong in `plugin.yaml` `runtime-postinstall`.
- MCP endpoints and allowed tool surfaces belong in `plugin.yaml` `mcp`.
- CLI env placeholders, deployment defaults, and public host-env bindings belong in `plugin.yaml` `command-env`.
- OAuth and static credential env names belong in `plugin.yaml` `oauth` and `credentials`.
- Skill text may diagnose missing runtime surfaces, but must not tell the agent to install packages, run installer scripts, configure API keys, or repair sandbox package installation from inside a user workflow.

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

## Backward compatibility

- Plugin-backed skills must migrate off `requires-capabilities`.
- Authenticated provider work should run the real provider command and let the runtime handle auth implicitly.
