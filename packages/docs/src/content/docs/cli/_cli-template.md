---
title: CLI Page Template
description: Canonical structure for Junior CLI command pages.
type: reference
prerequisites:
  - /start-here/quickstart/
related:
  - /cli/init/
  - /cli/check/
  - /cli/snapshot-create/
---

Use this template for `junior` command docs so readers get the same path from invocation to verification.

## Usage

Show the canonical command invocation first. If the command accepts an optional path or flag, include one realistic second example.

## Extended usage

Add optional path, subcommand, or flag examples only when they change how someone runs the command.

## What it does

Explain the command outcome in one short paragraph, then list the specific files, directories, or runtime surfaces it touches.

## Failure behavior

Show one real error shape and explain what the reader should fix next. Prefer actionable messages over internal implementation details.

## Verification

End with a short numbered flow that tells the reader how to confirm the command worked.

## Next step

Link to the next page the reader should open after the command succeeds.
