---
title: CLI Page Template
description: Required structure for Junior CLI command pages.
type: reference
prerequisites:
  - /start-here/quickstart/
related:
  - /cli/init/
  - /cli/check/
  - /cli/snapshot-create/
---

Use this template for `junior` command docs. Follow the writing rules in [Documentation Guidelines](/contribute/documentation-guidelines/). Give readers the same path from command to result.

## Usage

Show the main command first. If the command accepts an optional path or flag, include one realistic second example.

## Extended usage

Add optional path, subcommand, or flag examples only when they change how someone runs the command.

## What it does

Explain the command result in one short paragraph. Then list the files, directories, or parts of Junior that it changes.

## Failure behavior

Show one real error and explain what the reader should fix next. Tell the reader what to do. Do not add internal design details.

## Verification

End with a short numbered flow that tells the reader how to confirm the command worked.

## Next step

Link to the next page the reader should open after the command succeeds.
