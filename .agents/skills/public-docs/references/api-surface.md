# API Surface

## Scope

This skill targets the documentation app at `packages/docs`.

## Primary paths

- Content root: `packages/docs/src/content/docs`
- Docs config and nav: `packages/docs/astro.config.mjs`
- Docs package manifest: `packages/docs/package.json`
- Theme/style overrides: `packages/docs/src/styles/custom.css`
- Static assets: `packages/docs/public`

## Page model

Docs pages are Markdown/MDX files under `src/content/docs/**`.

Common top-level sections:

- `start-here`
- `concepts`
- `extend`
- `operate`
- `reference`
- `contribute`

## Frontmatter contract

Baseline fields for all pages:

- `title`
- `description`

Required for new or substantial updates (project docs policy):

- `type`: `conceptual` | `tutorial` | `reference` | `troubleshooting`
- `summary`: one-sentence outcome
- `prerequisites`: internal links needed before this page
- `related`: next useful pages

Source of truth: `src/content/docs/contribute/documentation-guidelines.md`.

## Navigation and IA

Sidebar and section ordering are configured in `astro.config.mjs` via `starlight(...).sidebar`.

Use redirects in `astro.config.mjs` when moving pages or replacing old routes.

## Generated API reference

`starlight-typedoc` builds API reference docs under `reference/api` from `packages/junior/src/*` entry points in `astro.config.mjs`.

When changing API reference expectations:

1. Confirm entry points are still correct.
2. Ensure narrative docs link to stable generated routes.

## Validation commands

From repo root:

```bash
pnpm docs:check
pnpm docs:build
```

Use `docs:check` for routine edits and `docs:build` when navigation, redirects, or generated output may change.
