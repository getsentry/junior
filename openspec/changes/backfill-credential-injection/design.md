# Design: `credential-injection`

## Goals

- Keep real provider secrets host-side and out of model-visible context, sandbox files, sandbox env, and command args.
- Issue provider credentials lazily from verified sandbox egress requests instead of skill load, command planning, or model intent.
- Bind user-owned provider leases to requester identity and the active sandbox egress context.
- Use plugin provider domain ownership as the authority for which credentials can be injected.
- Preserve command compatibility with non-secret placeholder env values.

## Non-Goals

- Specify OAuth callback UI and state validation; that belongs to `oauth-flows`.
- Specify manifest parsing in full; this capability consumes provider credential/domain declarations.
- Add command-intent or repo-intent inference as a credential boundary.
- Inject secrets into sandbox processes directly.
- Define provider-specific business authorization beyond broker profiles.

## Prior Art Summary

Vercel Sandbox firewall supports user-defined network policies that can forward matching HTTPS requests to a proxy with forwarding headers and a Vercel-issued OIDC token. Vercel Sandbox authentication supports OIDC as the recommended SDK auth path and explicit token/team/project credentials as a fallback. OAuth 2.0 defines refresh-token exchange for new access tokens without re-authorizing the user. GitHub Apps issue installation access tokens with explicit expiry and permissions; GitHub's API returns token, expiry, permissions, and repositories where applicable.

Sources:

- Vercel Sandbox firewall: https://vercel.com/docs/vercel-sandbox/concepts/firewall/
- Vercel Sandbox firewall request proxying: https://vercel.com/changelog/vercel-sandbox-firewall-now-supports-request-proxying-and-filtering
- Vercel Sandbox authentication: https://vercel.com/docs/vercel-sandbox/concepts/authentication
- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- GitHub App installation authentication: https://docs.github.com/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

## Decisions

### Provider Domain Ownership Is The Credential Boundary

Plugin manifests declare provider domains. Runtime resolves the provider from the forwarded upstream host and injects only transforms for that provider/domain. The model's planned command, skill prose, repo name, or tool label is not an authorization source.

### Credential Issuance Is Lazy

New sandboxes receive network policy and non-secret command env placeholders. Real leases are issued only when sandbox traffic reaches a registered provider domain and the forwarded request proves Vercel Sandbox identity plus Junior requester context.

### Requester Context Is Signed And Sandbox-Bound

The forwarding URL carries a signed requester context containing requester id, sandbox egress id, expiry, and context id. The egress proxy verifies that this context matches the Vercel OIDC sandbox id before issuing user-bound credentials.

### Leases Are Short-Lived And Header-Only

Credential leases contain provider, expiry, non-secret env placeholders, and host-side header transforms. The proxy applies transforms to forwarded requests; real tokens are never written into sandbox env vars or files.

### Auth Missing Is Command-Readable

When a provider broker cannot issue credentials, the proxy returns a plain-text `junior-auth-required provider=<provider>` marker so the command failure path can start the private auth flow and later resume the turn.

## Open Design Questions

- Whether exact-domain matching should expand to manifest-declared wildcards or subdomain policies.
- Whether static env token fallback should be forbidden in requester-bound production paths.
- How scheduled tasks and trusted plugin dispatch credential subjects should share this contract without reusing interactive requester assumptions.
- Whether command-readable auth markers should be modeled as a standardized tool error rather than proxy response text.
- Whether lease TTLs should be provider-configurable or globally capped only.
