---
title: Documentation Guidelines
description: Standards for writing and maintaining Junior public docs.
type: reference
summary: Keep Junior docs task-oriented, accurate, and easy to navigate.
prerequisites:
  - /contribute/development/
related:
  - /contribute/testing/
  - /contribute/releasing/
---

Junior public docs should help readers choose the right setup path, copy a working configuration, and verify behavior without reading internal implementation docs first.

## Page contract

Every new or substantially edited page should include:

| Field           | Purpose                                                             |
| --------------- | ------------------------------------------------------------------- |
| `type`          | One of `conceptual`, `tutorial`, `reference`, or `troubleshooting`. |
| `summary`       | One sentence that states the reader outcome.                        |
| `prerequisites` | Internal docs to read first, or `[]`.                               |
| `related`       | Next useful internal pages.                                         |

Use `description` for search and browser metadata. Use `summary` for the reader outcome.

## Page types

Choose one primary job per page:

| Type              | Use it for                                              |
| ----------------- | ------------------------------------------------------- |
| `tutorial`        | Step-by-step setup with verification.                   |
| `conceptual`      | Mental model, tradeoff, or reading path.                |
| `reference`       | Fast lookup for config, commands, APIs, or contracts.   |
| `troubleshooting` | Symptom, first check, recovery order, and verification. |

Avoid pages that mix tutorial, concept, and reference material unless the page is intentionally a short overview.

## Writing defaults

Lead with what the reader should do or decide. Keep examples minimal but runnable, and label code fences with the target file when the snippet belongs in a file.

Prefer:

- short task-oriented headings
- tables for config and choices
- concrete verification steps
- explicit next-step links
- provider setup details on plugin pages

Avoid:

- internal implementation chatter before the user-facing outcome
- stale migration details unless a redirect or compatibility note needs them
- multiple pages competing to explain the same setup step
- long inline commands that wrap poorly

## Navigation rules

When adding or moving a page:

1. Add it to `packages/docs/astro.config.mjs` if it should be discoverable.
2. Add redirects for old public routes.
3. Update related pages and package README links.
4. Run `pnpm docs:check`.

Docs that describe plugins must keep package lists aligned with the real `@sentry/junior-*` packages and release docs.

## Next step

Use [Development](/contribute/development/) for local docs commands, then run [Testing](/contribute/testing/) checks when docs changes touch product examples.
