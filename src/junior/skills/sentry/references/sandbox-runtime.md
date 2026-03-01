# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/sentry`.

## Credential strategy

1. Enable credentials with `jr-rpc issue-credential sentry.issues.read`.
2. Runtime injects `Authorization` header transform for `sentry.io` on the command execution.
3. The Sentry CLI reads `SENTRY_AUTH_TOKEN` from the lease env field.
4. Run CLI commands: `npx @sentry/cli <command>`.
5. No long-lived token persistence in sandbox files.

## Important constraint

- Do not assume credentials are automatically available inside the sandbox.
- Credentials are injected per command execution scope via header transforms.
- Do not store or print token values.
