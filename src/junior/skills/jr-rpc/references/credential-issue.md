# `jrRpc` action=issue

## Purpose

Issue a short-lived credential lease and return metadata for diagnostics.

## Syntax

`jrRpc action=issue capability=<capability> repo=<owner/repo> format=token|env|json`

## Required fields

- `action=issue`
- `capability`
- `repo`

## Formats

- `format=token`: one-line metadata summary (no secret value)
- `format=env`: redacted env key output (`KEY=[REDACTED]`)
- `format=json`: structured metadata with `envKeys`

## Behavior

- Never returns raw token values.
- Useful for validating capability/target wiring.
- Prefer `action=exec` for real operations.

## Example

`jrRpc action=issue capability=github.issues.read repo=getsentry/junior format=json`
