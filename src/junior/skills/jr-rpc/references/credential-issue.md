# `jr-rpc credential issue`

## Purpose

Issue a short-lived credential lease and return metadata for diagnostics.

## Syntax

`jr-rpc credential issue --cap <capability> --repo <owner/repo> --format token|env|json`

## Required flags

- `--cap`
- `--repo`

## Formats

- `--format token`: one-line metadata summary (no secret value)
- `--format env`: redacted env key output (`KEY=[REDACTED]`)
- `--format json`: structured metadata with `envKeys`

## Behavior

- Never returns raw token values.
- Useful for validating capability/target wiring.
- Prefer `credential exec` for real operations.

## Example

`jr-rpc credential issue --cap github.issues.read --repo getsentry/junior --format json`
