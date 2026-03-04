# Security Policy

## Status

Active policy for Junior runtime, sandbox execution, credential handling, and data protection.

## Scope

This policy applies to:

- Host runtime code (`src/chat/**`, `app/**`, `scripts/**`).
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

- Runtime issues short-lived, scoped credentials for skill-declared capabilities.
- Credential enablement is explicit via bash custom command `jr-rpc issue-credential <capability>`.
- Real tokens are delivered exclusively via host-level header transforms — the host proxies `Authorization` headers for matching API domains (e.g. `api.github.com`, `sentry.io`). The sandbox never sees real token values.
- When CLI tools require an auth env var (e.g. `SENTRY_AUTH_TOKEN`), set it to a non-secret placeholder so the tool proceeds to make HTTP requests. The host authenticates those requests via header transforms.
- Never inject real tokens into sandbox env vars, files, or command arguments.

### GitHub baseline

- Use GitHub App installation auth.
- Keep `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on host only.
- Sign App JWT on host, then exchange for installation token.
- Require `GITHUB_INSTALLATION_ID` for deterministic installation selection.
- Inject `Authorization` header transform for `api.github.com` domain.
- Set `GITHUB_TOKEN` in lease env to a placeholder — real token never enters the sandbox.

### OAuth authorization link privacy

- Authorization URLs contain user-specific CSRF state tokens and must **only** be visible to the requesting user.
- Deliver authorization links via Slack `chat.postEphemeral` (channels) or `chat.postMessage` in 1:1 DMs (where the conversation is already private).
- If private delivery fails, fall back to a DM to the user — **never** post an authorization URL as a visible message in a channel or group conversation.
- The agent must **never** receive or relay raw authorization URLs. If private delivery fails entirely, return an error instructing the user to DM the bot.

### Sentry baseline

- Use per-user OAuth tokens via Authorization Code Grant (RFC 6749 §4.1).
- Tokens are per Slack user ID, stored via `UserTokenStore` interface (Redis-backed `StateAdapterTokenStore`).
- Keep `SENTRY_CLIENT_SECRET` on host only.
- Token exchange and storage happen server-side in the OAuth callback handler — the agent never sees token values.
- Refresh tokens on host, deliver short-lived access tokens via header transforms.
- Fall back to static `SENTRY_AUTH_TOKEN` env var for dev/testing only.
- Inject `Authorization` header transform for `sentry.io` domain.
- Set `SENTRY_AUTH_TOKEN` in lease env to a placeholder — real token never enters the sandbox.
- See [OAuth Flows Spec](./oauth-flows-spec.md) for full flow details.

## Logging and redaction policy

- Never log token values, private keys, or raw Authorization headers.
- Log only safe metadata (skill, capability, target, outcome, expiry timestamp).

## Verification requirements

Privileged changes should verify:

- successful issuance path
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
