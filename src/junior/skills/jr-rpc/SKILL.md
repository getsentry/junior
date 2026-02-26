---
name: jr-rpc
description: Use host-mediated credential issuance for sandbox commands via the jrRpc tool. Use when a task needs short-lived provider credentials (for example GitHub) to run a command safely.
allowed-tools: bash jrRpc
---

# Credential Usage

Use this skill when a command needs temporary credentials injected by the harness.

## Preferred tool path

Use the `jrRpc` tool for credential operations:

- `action=exec` with `capability`, `repo`, and nested `command` for real work.
- `action=issue` with `capability`, `repo`, and optional `format` for diagnostics/metadata.
- Output is redacted metadata (no raw token values).

## Guardrails

- Never print, echo, or log credential values.
- Do not write credentials to files.
- Avoid shell debug tracing (`set -x`) when running credentialed commands.
- Keep repo target explicit via `repo=owner/repo`.

## Capability examples

- `github.issues.read`
- `github.issues.write`
- `github.issues.comment`
- `github.labels.write`

## Reference note

- Legacy `jr-rpc credential ...` shell syntax is deprecated in this runtime. Use the `jrRpc` tool directly.
