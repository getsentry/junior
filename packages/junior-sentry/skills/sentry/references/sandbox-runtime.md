# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/sentry`.

## Credential strategy

1. Loading this skill does not grant credentials. The host uses the current actor's OAuth connection or a credential subject explicitly delegated by the runtime, such as an event automation's creator.
2. Run CLI commands: `sentry <command>`. The host applies credentials to verified HTTP requests; the Sandbox receives only a non-secret placeholder. Do not set, persist, or print token env vars.
3. Bot-authored turns cannot start interactive OAuth or borrow a thread participant's connection. A creator-bound automation can use its creator's existing connection without interactive OAuth. If that connection is missing or needs reconnection, report the blocker to the creator.
4. When a later human turn asks for the data, retry the read under that turn rather than assuming the earlier bot-turn blocker still applies.
