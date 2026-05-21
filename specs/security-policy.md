# Security Policy

## Status

Active policy for Junior runtime, sandbox execution, credential handling, and data protection.

## Scope

This policy applies to:

- Host runtime code (`packages/junior/src/chat/**`, `packages/junior/app/**`, `packages/junior/scripts/**`).
- Sandbox/container execution paths.
- External provider credentials and token issuance.
- Skill execution and capability-gated access.
- Logging, tracing, and operational incident handling.

## Security principles

- Least privilege.
- Short-lived credentials over long-lived credentials.
- Isolate untrusted execution.
- Keep secrets out of logs and repository history.

## Runtime and sandbox policy

### Container and sandbox isolation

- User-influenced command execution must run in sandboxed environments.
- Sandbox filesystem is treated as ephemeral/untrusted.

### Sandbox network policy

- Production should use explicit network policy and minimal allowlists.
- Credential-capable provider domains should route through the Junior sandbox egress proxy instead of receiving long-lived sandbox secrets.
- Proxied sandbox egress requests must verify the Vercel-signed Sandbox OIDC token, use its sandbox claim as the active VM session id, resolve the provider from the Vercel forwarded host/path headers, and require a signed requester-bound context token in the forwarding route that matches the OIDC sandbox claim. Cached provider leases must be scoped to one requester/sandbox context and lease expiry.
- The egress handler must verify Vercel Sandbox OIDC before returning configuration, provider, or session-specific responses.
- The egress proxy must not reject duplicate method/URL/body requests as replay; duplicate request shapes can be legitimate retries. Requester-bound credential issuance is the security boundary.

### Harness-owned tool targeting

- For context-bound tools, destination/target resolution is owned by the runtime harness, not model-supplied tool arguments.
- Tool schemas must not expose destination override fields for context-bound operations unless explicitly approved by spec.
- When required context is missing, tools must fail safely with structured errors; they must not silently choose alternate/private scopes.
- Shared deliverables must not fall back to bot-private artifacts.
- See [Harness Tool Context Spec](./harness-tool-context-spec.md).

## Credential and token policy

### Secret custody

- Long-lived provider secrets stay in host-managed secret storage.
- Never commit long-lived secrets into repository files.
- Never write long-lived secrets into skill directories.

### Issuance and injection

- Runtime issues short-lived provider credentials when sandbox traffic reaches a registered provider domain.
- Registered plugin provider declarations determine which provider credentials may be injected for matching forwarded provider domains.
- A registered provider authorizes its declared domains for sandbox egress; registration must not mint credentials by itself.
- Credential issuance for user-owned provider access must be requester-bound; runtime paths without requester context must fail instead of issuing reusable credentials.
- Even for host-managed integrations, sandbox credentials are issued lazily only when a sandbox request reaches a declared provider domain. The runtime must not pre-provision provider credentials merely because a plugin is loaded or a command might need auth.
- Real provider secrets are delivered exclusively via host-level header transforms — the host proxies auth headers for matching provider domains (e.g. `Authorization` for `api.github.com`/`sentry.io` or provider-specific API key headers). The sandbox never sees real secret values.
- When CLI tools require tool-native sandbox auth env vars (for example `SENTRY_AUTH_TOKEN`, Pup's `DD_API_KEY`, or Pup's `DD_APP_KEY`), set them to non-secret placeholders so the tool proceeds to make HTTP requests. Placeholder values may be provider-specific via plugin manifest config. The host authenticates those requests via header transforms.
- Plugin-declared command env may include non-secret placeholders, default-backed deployment values, and explicit non-secret host env bindings needed by the command process. It must not read or expose env vars used by API headers, credential config, OAuth config, or other secret deployment values.
- Never inject real provider secrets into sandbox env vars, files, or command arguments.

### GitHub baseline

- Use GitHub App installation auth.
- Keep `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on host only.
- Sign App JWT on host, then exchange for installation token.
- Require `GITHUB_INSTALLATION_ID` for deterministic installation selection.
- Configure `GITHUB_APP_BOT_NAME` and `GITHUB_APP_BOT_EMAIL` as host env vars.
  They are public git author metadata, not credentials.
- Declare both `api.github.com` and `github.com` in the GitHub plugin manifest
  so the egress proxy forwards REST API and git HTTPS traffic through
  host-managed credential transforms.
- Disable git credential helpers in sandbox env (`GIT_ASKPASS`, `credential.helper=`) so git never sends its own auth — the proxy header transform is the sole credential source.
- Set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and
  `GIT_COMMITTER_EMAIL` from the configured GitHub App bot identity so
  sandbox commits are attributed to the installation bot, not a user named
  like the app slug.
- Set `GITHUB_TOKEN` in lease env to a placeholder — real token never enters the sandbox.
- Keep explicit `--repo owner/repo` and remote targets for command correctness and wrong-repo protection; they are not a credential-scoping boundary.

### OAuth authorization link privacy

- Authorization URLs contain user-specific CSRF state tokens and must **only** be visible to the requesting user.
- Deliver authorization links via Slack `chat.postEphemeral` (channels) or `chat.postMessage` in 1:1 DMs (where the conversation is already private).
- If private delivery fails, fall back to a DM to the user — **never** post an authorization URL as a visible message in a channel or group conversation.
- Visible Slack thread acknowledgements may say that authorization is needed and that a private link was sent, but must not include the authorization URL.
- The agent must **never** receive or relay raw authorization URLs. If private delivery fails entirely, return an error instructing the user to DM the bot.

### Sentry baseline

- Use per-user OAuth tokens via Authorization Code Grant (RFC 6749 §4.1).
- Tokens are per Slack user ID, stored via `UserTokenStore` interface (Redis-backed `StateAdapterTokenStore`).
- Keep `SENTRY_CLIENT_SECRET` on host only.
- Token exchange and storage happen server-side in the OAuth callback handler — the agent never sees token values.
- Refresh tokens on host, deliver short-lived access tokens via header transforms.
- Fall back to static `SENTRY_AUTH_TOKEN` env var only for local/dev/test paths outside requester-bound turn execution.
- Inject `Authorization` header transform for `sentry.io` domain.
- Set `SENTRY_AUTH_TOKEN` in lease env to a placeholder — real token never enters the sandbox.
- See [OAuth Flows Spec](./oauth-flows-spec.md) for full flow details.

## Logging and redaction policy

- Never log token values, private keys, or raw Authorization headers.
- Log only safe metadata (skill, capability, target, outcome, expiry timestamp).

## Verification requirements

Privileged changes should verify:

- successful automatic injection path
- failed issuance path
- lease expiry/refresh behavior
- no secret values in logs

## Incident response

If credential leakage is suspected:

1. Rotate affected long-lived secrets.
2. Revoke active short-lived tokens where possible.
3. Audit impact window in logs/traces.
4. Patch and re-verify.

## Policy ownership

- Runtime maintainers own this policy.
