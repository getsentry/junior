# Backfill CLI Specs

## Why

Junior exposes a published `junior` package binary used by new apps and deployment builds. The CLI currently supports app scaffolding, app/plugin/skill validation, and sandbox snapshot warmup. Those commands are covered by tests and docs, but the behavior is not expressed as an OpenSpec capability.

The baseline needs to define the stable CLI contract without over-specifying incidental console styling.

## What Changes

- Add a `cli` spec for:
  - package bin loading and built module availability;
  - command dispatch and usage errors;
  - CLI env-file loading;
  - `junior init <dir>` scaffold behavior;
  - `junior check [dir]` validation scope and failure model;
  - `junior snapshot create` warmup behavior;
  - output/error compatibility and verification expectations.
- Record open questions around CLI compatibility, docs drift, and formatter stability.

## Out of Scope

- Implementing new CLI commands.
- Freezing every line of human-facing output.
- Defining release packaging beyond the CLI `bin` and built-entry contract.
- Defining plugin manifest or skill syntax; those are owned by their respective specs.

## Impact

CLI changes will have an explicit contract for command shape, exit behavior, generated app structure, and validation scope. Tests can remain focused on behavior rather than brittle formatting.
