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

## Credential and token policy

### Secret custody

- Long-lived provider secrets stay in host-managed secret storage.
- Never commit long-lived secrets into repository files.
- Never write long-lived secrets into skill directories.

### Issuance and injection

- Runtime issues short-lived, scoped credentials for skill-declared capabilities.
- Credential enablement is explicit via bash custom command `jr-rpc issue-credential <capability>`.
- Preferred delivery is sandbox network-policy header transforms (for example Authorization on `api.github.com`).
- Do not inject privileged tokens into sandbox command env or files.

### GitHub baseline

- Use GitHub App installation auth.
- Keep `GITHUB_APP_PRIVATE_KEY` on host only.
- Sign App JWT on host, then exchange for installation token.
- Require `GITHUB_INSTALLATION_ID` for deterministic installation selection.

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
