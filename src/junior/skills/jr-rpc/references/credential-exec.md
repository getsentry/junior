# `jrRpc` action=exec

## Purpose

Run a nested command with short-lived credential env vars injected for that command scope only.

## Syntax

`jrRpc action=exec capability=<capability> repo=<owner/repo> command='<command>'`

## Required fields

- `action=exec`
- `capability`
- `repo`
- `command`

## Example

`jrRpc action=exec capability=github.issues.write repo=getsentry/junior command='node /vercel/sandbox/skills/gh-issue/scripts/gh_issue_api.mjs create --repo getsentry/junior --title "Smoke test" --body-file /tmp/body.md'`

## Behavior

- Issues a short-lived lease from host runtime.
- Injects provider env keys (for example `GITHUB_TOKEN`) only for the nested command.
- Returns nested command stdout/stderr/exit details.

## Failure modes

- Missing required fields: validation errors for capability/repo/command.
- Provider setup/auth failures: host credential broker errors.
- Nested command failure: non-zero exit from nested command.
