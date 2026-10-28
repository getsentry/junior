# Vercel skill contract

## Intent and shape

Guide Vercel operations through plugin tools and the CLI. Use inline guidance;
tool schemas own API inputs and outputs.

## Evidence and limits

Tool schemas and official Vercel APIs define operation inputs. Provider
responses supply deployment and alias evidence. The existing token and runtime
review remain authoritative; the skill does not grant permission.

Alias checks are not a lock. Builds inherit credentials and can run migrations.
A ready deployment does not prove Slack QA passed.

## Validation and maintenance

Trigger for requests such as "deploy this commit to Vercel", "move this alias",
"delete this Vercel deployment", and "show Vercel build logs". Do not trigger
for "open a GitHub PR" or "deploy to AWS".

The plugin's action tests cover request payloads, environment selection, alias
changes, and failures. Run `pnpm skills:check` after skill edits. Live Vercel
execution and Slack QA need separate validation.
