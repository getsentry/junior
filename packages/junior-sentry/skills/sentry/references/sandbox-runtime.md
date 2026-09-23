# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/sentry`.

## Credential strategy

1. Loading this skill does not grant credentials. The host uses the current actor's OAuth connection or an operator-configured, read-only service connection.
2. Run CLI commands: `sentry <command>`. The host applies credentials to verified HTTP requests; the Sandbox receives only a non-secret placeholder.
3. Do not set, persist, or print token env vars. Bot-authored turns cannot start interactive OAuth or borrow a thread participant's connection. If a later human turn needs the data, retry the read under that turn rather than assuming the earlier blocker still applies.
4. Service mode permits only read-only API requests. If the runtime reports a missing or rejected service connection, report that an operator must repair it. Do not ask the user to reconnect OAuth or try another route around a denied write.
