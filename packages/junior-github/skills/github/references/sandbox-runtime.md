# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and commands execute via the `bash` tool.

## Runtime environment

- Sandbox OS is Amazon Linux 2023.
- System packages are installed with `dnf`.
- Any package install command must run with root privileges (`sudo: true` in sandbox command execution).

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/<skill-name>`.

## Important constraint

Credentials should only be injected per command execution scope. Do not rely on global/session-wide environment for privileged tokens.

## Credential strategy

1. Enable credentials with the narrowest capability needed:
   - `github.contents.read` for `gh repo clone` and repository checkout
   - `github.contents.write` for `git push` and content mutations
   - `github.issues.read` for `view` and comment reads
   - `github.issues.write` for create/update/close/reopen
   - `github.issues.comment` for comments
   - `github.labels.write` for label mutations
   - `github.pull-requests.read` for viewing PRs
   - `github.pull-requests.write` for creating/updating/merging PRs
2. Runtime injects `Authorization` header transforms for `api.github.com` (and `github.com` for `contents.read`/`contents.write`).
3. For `contents.read`/`contents.write`, the real token is also set in `GITHUB_TOKEN` so `gh repo clone` and `git push` can authenticate via git credential helper.
4. Execute `gh` CLI commands directly.
5. Do not persist tokens in files.

## Operational checks

- Verify CLI availability:
  - `gh --version`
- Use non-interactive command flags in automation contexts.
- If 401/403 appears after credential issuance, reissue once, then stop with remediation guidance if still failing.
