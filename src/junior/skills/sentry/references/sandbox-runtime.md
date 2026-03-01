# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/sentry`.

## Credential strategy

1. Enable credentials with `jr-rpc issue-credential sentry.issues.read`.
2. Runtime injects `Authorization` header transform for `sentry.io` — the host proxies the real token at the HTTP layer.
3. `SENTRY_AUTH_TOKEN` is set to a placeholder so CLI tools don't fail on missing auth. The real token never enters the sandbox.
4. Run CLI commands: `npx @sentry/cli <command>`.
5. No long-lived token persistence in sandbox files.

## Important constraint

- Do not assume credentials are automatically available inside the sandbox.
- Credentials are injected per command execution scope via header transforms.
- Do not store or print token values.
