---
name: jr-rpc
description: Manage low-level config and plugin introspection flows via jr-rpc bash commands. Use only when the user explicitly asks to read or update provider defaults/config or list installed plugins. Do not use for PR, branch, push, or auth-order questions; load the matching provider skill instead.
allowed-tools: bash
---

# jr-rpc

Manage low-level config and plugin introspection flows for the current agent turn.

## Plugins

`jr-rpc plugins list` — list installed plugins visible to the current Junior runtime.

Command syntax:

- `jr-rpc plugins list`

## Configuration

`jr-rpc config get|set|unset|list` — read and write channel-scoped configuration values.

Command syntax:

- `jr-rpc config get <key>`
- `jr-rpc config set <key> <value> [--json]`
- `jr-rpc config unset <key>`
- `jr-rpc config list [--prefix <value>]`

Rules:

- Choose config keys from the runtime `<providers>` catalog: `<provider>.<config_key>`.
- For "default repo" requests, use the provider target key, for example `github.repo`.
- Run the exact standalone command. Do not probe, install, or repair `jr-rpc`; the runtime handles it only when invoked directly.

## Guardrails

- Use exact config keys from the loaded skill or provider catalog; do not invent them.
- Do not use this skill to choose a provider for an unrelated operational task. Load the matching domain skill first, then run the real provider command.
- Do not print credential values.
