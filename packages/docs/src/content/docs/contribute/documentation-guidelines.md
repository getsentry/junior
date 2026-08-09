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

Junior public docs must help readers choose a setup path, copy a working configuration, and check the result. Readers should not need to read internal design docs first.

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
| `conceptual`      | Core idea, choice, or reading path.                     |
| `reference`       | Fast lookup for config, commands, APIs, or contracts.   |
| `troubleshooting` | Symptom, first check, recovery order, and verification. |

Avoid pages that mix tutorial, concept, and reference material unless the page is intentionally a short overview.

## Writing rules

Use ASD-STE100 English. Use common words, active voice, short sentences, and one idea per sentence. Keep required Junior terms from the root `TERMINOLOGY.md`. Explain a required term the first time a new reader may see it. Remove other jargon.

Lead with what the reader must do or decide. Keep examples small and runnable. Add the target file name to a code block when the code belongs in a file.

Prefer:

- short task-oriented headings
- tables for config and choices
- concrete verification steps
- explicit next-step links
- provider setup details on plugin pages

Avoid:

- internal design details before the user-facing result
- old migration details unless a redirect or support note needs them
- multiple pages competing to explain the same setup step
- long inline commands that wrap poorly

## Navigation rules

When adding or moving a page:

1. Add it to `packages/docs/astro.config.mjs` if it should be discoverable.
2. Add redirects for old public routes.
3. Update related pages and package README links.
4. Check each changed sentence against the writing rules above.
5. Run `pnpm docs:check`.

Docs that describe plugins must keep package lists aligned with the real `@sentry/junior-*` packages and release docs.

## Next step

Use [Development](/contribute/development/) for local docs commands, then run [Testing](/contribute/testing/) checks when docs changes touch product examples.
