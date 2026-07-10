# Credential Injection Spec

## Metadata

- Created: 2026-02-26
- Last Edited: 2026-06-09

## Related

- [Security Policy](./security-policy.md)
- [OAuth Flows Spec](./oauth-flows.md)
- [Plugin Architecture Spec](./plugin.md)
- [Identity Spec](./identity.md)

## Purpose

Define how Junior maps registered plugin provider domains to host-managed credentials without exposing secrets or manual auth commands to the model.

## Core model

1. Plugin manifests own provider domains, credentials, command env, OAuth config, and runtime setup. See [Plugin Architecture Spec](./plugin.md).
2. Skills do not declare capabilities, config keys, credentials, provider domains, or runtime setup.
3. The agent runs the real provider command. Runtime authentication is implicit and host-owned.
4. The runtime resolves the provider from the outgoing request host, lazily issues a credential-context-bound provider lease, and applies credential headers to that forwarded request.
5. If credentials are missing, stale, or unavailable, the proxy records a structured host-side credential signal and returns a command-readable auth response. Plugin auth orchestration starts a private OAuth flow only when that signal is `auth_required` and carries OAuth authorization metadata, then resumes the paused turn after authorization.

## Runtime contract

### Lease issuance

- Resolve provider from the Vercel Sandbox forwarded host for proxied sandbox egress.
- Require a signed credential context before issuing provider credentials. The context has a current execution actor and may carry an explicit user credential subject.
- Credential contexts must carry exact real actor ids. Synthetic sentinel values such as `unknown` are invalid for user actors, system actors, and delegated user subjects.
- Actor, actor, system actor, service-principal, and delegated credential subject semantics follow the [Identity Spec](./identity.md). Credential brokers must not infer actor identity from actor metadata, creator metadata, destination, or display profile fields.
- Agent reply callers pass credential context explicitly. Actor and correlation metadata are not credential inputs.
- The current actor controls provider permission envelopes. A user credential subject only identifies which stored user OAuth token may be used.
- System actors may carry an explicit user credential subject only from a runtime boundary that bound or verified the subject for that action. Plugin dispatch accepts the plugin-facing unbound Slack DM subject, signs it at dispatch creation, and stores only the bound subject in dispatch and sandbox egress contexts.
- User-owned OAuth credentials require either a current user actor or an explicit user credential subject. System actors without a user subject may use only provider credentials that are explicitly service-principal or install-owned, such as GitHub App installation credentials or static operator env credentials.
- Return short-lived leases only.
- Keep any host-side egress lease cache bounded by the signed credential/sandbox context expiry and lease expiry.

### Injection behavior

- Enablement happens when sandbox traffic reaches a registered provider domain, not at skill-load time.
- Delivery uses the Vercel Sandbox firewall request proxy for provider domains when available, with host-side header injection on the forwarded request.
- Plugin-managed credentials may define `auth-token-env` and a provider-specific `auth-token-placeholder` for CLI compatibility; request credentials still come from plugin hooks.
- Plugin manifests may define sandbox-visible `command-env` values for CLI compatibility. These may include placeholder API keys, deployment defaults, or host env bindings explicitly marked `expose-to-command-env`; provider auth secrets that should remain host-only belong in credentials or API headers.
- Do not inject long-lived secrets into sandbox files.
- Credential issuance is intentionally lazy to avoid wasted token minting and provider compute for commands that never touch authenticated domains.
- Do not infer provider access from bash commands, skill prose, or planned work to pre-scope tokens. Fine-grained token scopes are desirable, but guessing access needs is not a safe authorization boundary; provider/domain matching at request time is the contract.

### Sandbox egress proxy

- New sandbox sessions use a Vercel Sandbox network policy that forwards declared credential provider domains to Junior's internal egress handler.
- The runtime configures the forwarding URL with a signed credential context bound to the sandbox VM session so the proxy can mint provider leases lazily without a state-store lookup.
- The internal egress handler must verify the Vercel Sandbox OIDC token and signed credential/sandbox context before proxying.
- The egress route must reconstruct the upstream URL only from Vercel forwarded host/scheme/port/path headers. The proxy route URL contains Junior routing state and must not be used as the upstream path.
- The egress route must reject forwarded hosts that do not match a registered provider domain.
- The proxy must not use method/URL/body-only replay fingerprints as an authorization boundary because duplicate request shapes can be legitimate client retries.
- The proxy must strip hop-by-hop and proxy-control headers before sending the upstream request.
- Sandbox-supplied request headers and upstream response state may pass through once Vercel OIDC, credential context, and provider-domain ownership have been verified.
- Trace propagation headers (`sentry-trace`, `baggage`, and `traceparent`) are stricter: the sandbox network policy may attach them only for egress domains configured through `createApp({ sandbox: { egressTracePropagationDomains } })`. Config entries may be exact domains or leading wildcard domains such as `*.sentry.io`; the proxy strips trace headers from all other upstream requests.
- Provider-owned egress response hooks may inspect upstream response metadata after a credentialed request is forwarded. The proxy must not read upstream response bodies by default.
- Response hooks may inspect a body only through the proxy's bounded lazy reader, which clones the response, enforces a hard byte cap, and leaves the original upstream response body available for pass-through.
- A response hook that returns normally must preserve the original upstream response. Throwing `EgressAuthRequired` is the only response-hook outcome that rewrites the upstream response to Junior's auth-required sentinel.
- A response hook may record a provider permission denial as a host-side signal while still preserving the original upstream response.

### Security goals

- Secrets are hidden from the model and sandbox filesystem.
- Credentials are credential-context-bound.
- Leases are valid only for the active turn.
- Provider defaults may guide command construction, but credential availability is still provider-level and turn-bound.

## GitHub profile

### Permission model

- Plugin manifest capabilities map to GitHub App installation permissions.
- The GitHub plugin selects `installation-read` for app-readable egress,
  repository-scoped `installation-issues-write` and
  `installation-pull-requests-write` grants for Junior-owned resource
  mutations, `installation-pr-branch-write` for Git smart-HTTP pushes,
  `user-read` for actor-account identity reads, and `user-write` only for
  explicitly enumerated human-identity operations such as pull request
  reviews.
- Headless system turns, including resource-event subscription deliveries, may
  issue the scoped installation grants without a user credential subject. This
  allows Junior to react to its own pull request events by committing and
  pushing fixes while human reviews and other user-owned operations still
  require explicit delegated authorization.
- GitHub App user-to-server tokens are not OAuth-scope-authorized. GitHub returns `scope: ""` for these token responses. Their effective access is the intersection of the GitHub App permissions, the app installation's repository access, and the requesting user's own GitHub access.
- Any configured GitHub user OAuth scope string is a Junior-local reauthorization contract only. It must not be treated as provider-verified proof that GitHub granted those scopes or as a mechanism for expanding GitHub App permissions.
- Installation read tokens receive an explicit read-only permission body.
  Installation write tokens are restricted to the target repository and the
  minimum permission family selected by the grant.
- Repo context is required for installation writes because the canonical
  repository identity is carried in the plugin-owned lease scope.

### Lease behavior

- Header transforms target the domains declared by the GitHub plugin manifest.
- The GitHub API host is the exact declared `api.github.com` domain, independent of manifest order.
- The built-in GitHub plugin declares `api.github.com` for REST API calls and
  `github.com` for git smart-HTTP.
- Runtime may reuse a short-lived sandbox egress lease for repeated GitHub commands in the same turn, but cache keys include the plugin grant name and opaque lease scope. A repository-scoped write lease must not be reused for another repository or grant family.
- GitHub read grants are derived from runtime-visible HTTP evidence, including safe HTTP methods, GraphQL queries, `GET /user`, and `git-upload-pack`. Only allowlisted issue and pull request REST writes receive scoped installation resource grants. `git-receive-pack` receives the repository-scoped `installation-pr-branch-write` grant. Unknown REST writes and GraphQL mutations are denied rather than falling back to `user-write`.
- The smart-HTTP push classifier scopes the token to the repository but does
  not independently distinguish a Junior-managed branch, detect a force
  update or ref deletion, or inspect the pushed commit range. Deployments must use GitHub
  branch protection and App installation scope for those controls. Workflow
  pushes require `Workflows: write` when that permission is configured.
- Raw sandbox GitHub issue and pull request creation is rejected before credential issuance. `POST /repos/:owner/:repo/issues`, `POST /repos/:owner/:repo/pulls`, GraphQL `createIssue` mutations, and GraphQL `createPullRequest` mutations must use the typed host/plugin tools `github_createIssue` and `github_createPullRequest`, which call the host/plugin operations `github.issue.create` and `github.pull.create` and own idempotency and the runtime-generated conversation footer. Rejected raw creation returns HTTP 403, records no auth-required signal, and does not contact GitHub.
- Raw sandbox GitHub GraphQL `POST` bodies that exceed the inspection cap are rejected before credential issuance because Junior cannot prove they are not issue or pull request creation requests.
- When a GitHub App installation lease is issued, the GitHub plugin sends an explicit permission body instead of inheriting the installation's default permissions.
- If the plugin declares GitHub App permissions, each read-capable configured
  permission is requested at `read` level for installation-read leases.
- If no GitHub App permissions are declared, the plugin reads the installation
  permission envelope once per process and requests each read-capable
  discovered permission at `read` level.
- Provider `401` responses discard the cached sandbox egress lease so the next request re-issues from current provider state.
- When an upstream `401` is received for a request where Junior injected a provider credential, the proxy replaces the raw provider response body with the command-readable `junior-auth-required provider=<name> grant=<grant> access=<read|write> 401 unauthorized` sentinel and records a host-side credential signal with `kind: "auth_required"` for the active sandbox egress session. Plugin auth orchestration must trust only the host-side signal for provider grant requirements; raw command stdout/stderr is attacker-influenceable and must not prove GitHub write access or trigger user-token unlink.
- Upstream `403` responses are permission denials for an issued lease, not missing authorization. They pass through raw, clear the cached lease, and record a host-side `permission_denied` signal on failed bash results with `source: "upstream"`, a message that states the request was forwarded, provider, grant, upstream target, connected provider account when known, plugin-declared requirements when known, and provider permission headers such as GitHub's `X-Accepted-GitHub-Permissions` when present.
- The GitHub plugin may also record `permission_denied` for GitHub GraphQL HTTP `200` responses whose JSON `errors[]` carry known access-denial semantics, such as repository `NOT_FOUND` or `Resource not accessible by integration`. These responses must pass through unchanged, and the signal status must preserve the real upstream HTTP status.
- GitHub `user-read` and explicitly selected `user-write` grants require a stored GitHub user-to-server OAuth token. Bot-owned issue, pull request, and branch-push grants never fall back to this token or start OAuth when installation credentials are unavailable.
- For GitHub App user-to-server tokens, an empty provider `scope` response is treated as unreported scope information. Junior persists the requested scope string so future broker checks can detect local reauthorization-contract changes. Provider authorization is enforced by GitHub permissions and upstream `401`/`403` responses, not Junior scope checks.
- GitHub installation grants use GitHub App installation tokens. Installation credential failures are operational app/installation failures and must record `kind: "unavailable"` without OAuth authorization metadata; they must not trigger user OAuth.

## Sentry profile

### Permission model

- The Sentry plugin currently declares a single host-side capability: `sentry.api`.
- Runtime still treats issuance as provider-level, not command-level.

### OAuth behavior

- `OAuthBearerBroker` checks for a per-user OAuth token stored by the credential user subject ID, which is the current user actor or an explicit delegated user subject.
- If the token is near expiry, runtime refreshes it server-side.
- Missing or stale auth triggers the private OAuth resume flow defined in the OAuth Flows Spec.

## Observability

Emit events without secret material:

- `sandbox_egress_upstream_request`
- `sandbox_egress_credential_needed`
- `sandbox_egress_credential_unavailable`
- `sandbox_egress_upstream_auth_rejected`
- `sandbox_egress_upstream_auth_required_classified`
- `sandbox_egress_upstream_permission_classified`

## Non-goals

- Skill-level capability allowlists.
- Model-visible auth-management commands.
- Provider-specific policy engines beyond actor and turn scoping.
- Using arbitrary skill prose as an authority source for runtime package installation, MCP setup, command env, or credential configuration.
