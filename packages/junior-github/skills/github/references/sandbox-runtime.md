# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and scripts execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- GitHub CLI (`gh`) preinstalled via runtime dependencies.
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/<skill-name>`.

## Important constraint

Credentials should only be injected per command execution scope. Do not rely on global/session-wide environment for privileged tokens.

Practical implication:
- Do not assume app credentials are automatically available inside the sandbox.
- Prefer short-lived installation token delivery via sandbox header transforms.

## Credential strategy

1. Enable credentials with `jr-rpc issue-credential github.issues.write` (or the appropriate capability).
2. Runtime injects `Authorization` header transforms for `api.github.com`.
3. Run script commands: `node /vercel/sandbox/skills/github/scripts/gh_issue_api.mjs <command>`.
4. No long-lived token persistence in sandbox files.
