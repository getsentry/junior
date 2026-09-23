# Vercel skill contract

## Intent and shape

Keep read-only CLI investigation. Add opt-in Preview tools for an exact commit
and one configured alias. This is an inline workflow skill. No router, worker,
or script is required in the skill.

## Evidence and limits

Tool schemas and plugin credential hooks define the allowed actions. Vercel
API responses provide deployment and alias evidence. Alias checks are not a
lock. Builds inherit Preview secrets and migrations. A ready deployment does
not prove Slack QA passed.

## Validation

Requests to inspect logs, deploy a trusted Preview, or check the QA alias should
trigger this skill. Production deploys, environment changes, and unrelated
cloud providers must not use its write path. Keep tests for exact-commit scope,
raw CLI write rejection, foreign deployments, and alias changes in the plugin.

## Maintenance

Update this contract with the tool schemas and credential policy. Keep tokens
host-side. Never replace denied Preview tools with unrestricted CLI commands.
