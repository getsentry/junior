# `jr-rpc` command reference

## Syntax

`jr-rpc issue-credential <capability> [--repo <owner/repo>]`

## Required args

- `<capability>` (provider-qualified, for example `github.issues.write`)
- optional `--repo <owner/repo>` to scope credentials to one repository

## Common errors

- `jr-rpc issue-credential requires a capability argument`
- `jr-rpc issue-credential requires exactly one capability argument`
- `Unsupported jr-rpc command. Use: jr-rpc issue-credential <capability>`
