# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/<skill-name>`.

## Credential strategy

1. After the GitHub skill is loaded, the runtime injects GitHub credentials implicitly for the current turn.
2. Keep repository context explicit on `gh` and `git` commands so the command itself targets the correct repo.
3. Credentials are valid only for the current turn. Do not persist tokens in files.
4. If auth fails, verify the command still targets the correct repo, then retry the real GitHub command once so the runtime can reconnect automatically when needed.
