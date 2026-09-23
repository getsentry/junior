# Vercel skill contract

## Intent and shape

Support general Vercel operations through plugin tools and the CLI. Keep the
workflow inline. QA is one use case, not a credential or project boundary.

## Evidence and limits

Tool schemas and official Vercel APIs define operation inputs. Provider
responses supply deployment and alias evidence. The existing token and runtime
review remain authoritative; the skill does not grant permission.

Alias checks are not a lock. Builds inherit credentials and can run migrations.
A ready deployment does not prove Slack QA passed.

## Validation and maintenance

Log investigations, deployments, alias changes, and requested deletion should
trigger this skill. GitHub source changes and other cloud providers should not.
Keep component coverage for request payloads, environment selection, alias
changes, and failures in the plugin. Keep Guardian review unchanged. Do not
introduce a second required token or QA-specific app options.

Sources: plugin tool schemas and Vercel REST documentation for deployment
creation/inspection/deletion and alias assignment/inspection. Live provider
execution and end-to-end Slack QA are separate validation steps.
