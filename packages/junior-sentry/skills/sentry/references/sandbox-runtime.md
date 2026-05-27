# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/sentry`.

## Credential strategy

1. After the Sentry skill is loaded, authenticated Sentry HTTP traffic is available for the current turn.
2. Run CLI commands: `sentry <command>`.
3. Credentials are scoped per command execution. Do not set, persist, or print token env vars.
