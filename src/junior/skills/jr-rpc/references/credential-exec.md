# `jr-rpc credential exec`

## Purpose

Run a nested command with short-lived credential env vars injected for that command scope only.

## Syntax

`jr-rpc credential exec --cap <capability> --repo <owner/repo> -- <command>`

## Required flags

- `--cap`
- `--repo`
- `-- <command>`

## Example

`jr-rpc credential exec --cap github.issues.write --repo getsentry/junior -- node /vercel/sandbox/skills/gh-issue/scripts/gh_issue_api.mjs create --repo getsentry/junior --title "Smoke test" --body-file /tmp/body.md`

## Behavior

- Issues a short-lived lease from host runtime.
- Injects provider env keys (for example `GITHUB_TOKEN`) only for the nested command.
- Returns nested command stdout/stderr/exit details.

## Failure modes

- Missing flags: parser errors for required options.
- Provider setup/auth failures: host credential broker errors.
- Nested command failure: non-zero exit from nested command.
