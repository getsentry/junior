---
name: public-docs
description: Create and maintain public, user-facing product documentation for this repo's `packages/docs` app. Use when asked to write, revise, or review docs pages (tutorial/concept/reference/troubleshooting), improve docs information architecture, fix docs frontmatter/linking issues, or align docs quality with Vercel/Sentry-style standards.
---

# Public Docs

Use this workflow to produce docs that are crisp, task-oriented, and trustworthy for external users.

Load only the references needed for the request:

| Task | Read |
|------|------|
| Understand docs app layout and constraints | `references/api-surface.md` |
| Draft or revise common docs pages | `references/common-use-cases.md` |
| Diagnose docs quality/build failures | `references/troubleshooting-workarounds.md` |

## Core invariants

1. Keep docs audience-facing: explain user outcomes, not internal implementation chatter.
2. Match the local docs contract in `packages/docs/src/content/docs/contribute/documentation-guidelines.md`.
3. For new or substantially edited pages, require frontmatter fields: `type`, `summary`, `prerequisites`, `related`.
4. Include concrete verification steps for tutorial/troubleshooting content.
5. End each page with an explicit "next step" path through internal links.
6. Prefer minimal runnable examples over long conceptual exposition.
7. Keep prose present around lists; avoid heading-plus-bullets-only sections.

## Workflow

### 1. Classify the request

Select one primary path:

- New page authoring
- Existing page refactor/clarification
- Information architecture update (sidebar/redirects/navigation)
- Docs quality pass (accuracy, scannability, consistency)
- Troubleshooting/build-fix for docs app

### 2. Gather local context

1. Read `packages/docs/src/content/docs/contribute/documentation-guidelines.md`.
2. Read neighboring docs in the same section (`start-here`, `concepts`, `extend`, `operate`, `reference`, `contribute`).
3. If navigation is involved, read `packages/docs/astro.config.mjs` (`sidebar` and `redirects`).
4. If API docs are involved, confirm generated reference surface under `packages/docs/src/content/docs/reference/api`.

### 3. Author or edit with the right page shape

1. Pick doc `type` (`conceptual`, `tutorial`, `reference`, `troubleshooting`) from intent.
2. Follow depth and section guidance from documentation guidelines.
3. Keep wording direct and plain; remove filler or internal-only caveats.
4. Use titled code fences for file snippets.
5. Prefer internal links that advance the reader to the next concrete action.

### 4. Validate changes

Run the narrowest meaningful checks:

```bash
pnpm docs:check
```

When structure, sidebar, redirects, or generated reference behavior changes, also run:

```bash
pnpm docs:build
```

### 5. Report completion

Return:

1. Changed files and what each change improves for readers
2. Validation commands executed and outcome
3. Residual risks (for example, missing screenshots, unverified env-specific setup)
