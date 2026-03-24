# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/<skill-name>`.

## Credential strategy

1. Issue credentials with `jr-rpc issue-credential <capability>` before executing commands. See [api-surface.md](api-surface.md) for the capability-to-command mapping.
2. Credentials are scoped per command execution. Do not persist tokens in files.
3. If 401/403 appears after credential issuance, reissue once, then stop with remediation guidance.
