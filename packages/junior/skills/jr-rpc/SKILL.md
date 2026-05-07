---
name: jr-rpc
description: Manage low-level config flows via jr-rpc bash commands. Use only when the user explicitly asks to read or update provider defaults/config. Do not use for PR, branch, push, or auth-order questions; load the matching provider skill instead.
allowed-tools: bash
---

# jr-rpc

Manage low-level config flows for the current agent turn.

## Configuration

`jr-rpc config get|set|unset|list` — read and write channel-scoped configuration values.

- Choose config keys from the runtime `<providers>` catalog.

Read `${CLAUDE_SKILL_ROOT}/references/commands.md` for full command syntax and response shapes.

Read `${CLAUDE_SKILL_ROOT}/references/capabilities.md` for config-key selection rules.

## Guardrails

- Use exact config keys from the loaded skill or provider catalog; do not invent them.
- Do not use this skill to choose a provider for an unrelated operational task. Load the matching domain skill first, then run the real provider command.
- Do not print credential values.
