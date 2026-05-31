# Docs Site Backfill Worksheet

## Canonical Spec

- New spec: `docs-site`

## Local Artifacts Reviewed

- `.agents/skills/public-docs/SKILL.md`
- `.agents/skills/public-docs/references/api-surface.md`
- `packages/docs/package.json`
- `packages/docs/astro.config.mjs`
- `packages/docs/src/content.config.ts`
- `packages/docs/src/content/docs/contribute/documentation-guidelines.md`
- `packages/docs/src/content/docs/index.mdx`
- `packages/docs/src/content/docs/**/*.md`
- `packages/docs/src/styles/custom.css`
- `package.json`
- `.github/workflows/ci.yml`

## External Sources

- Starlight sidebar docs: https://starlight.astro.build/guides/sidebar/
- Starlight frontmatter/schema docs: https://starlight.astro.build/reference/frontmatter/
- Starlight configuration docs: https://starlight.astro.build/reference/configuration/
- Astro routing redirects docs: https://docs.astro.build/en/guides/routing/#redirects
- Astro content collections docs: https://docs.astro.build/en/guides/content-collections/
- TypeDoc input docs: https://typedoc.org/documents/Options.Input.html
- TypeDoc output docs: https://typedoc.org/documents/Options.Output.html

## Current Behavior Summary

- Docs app uses Astro/Starlight with a Sentry theme and custom CSS.
- Sidebar and redirects are manually configured in `astro.config.mjs`.
- `content.config.ts` extends Starlight docs schema with optional `type`, `summary`, `prerequisites`, and `related`.
- Documentation guidelines require those fields for new/substantially edited pages.
- API reference pages are generated from `packages/junior/src/api-reference.ts` using `starlight-typedoc`.
- Root scripts expose `docs:dev`, `docs:build`, and `docs:check`.
- CI runs `pnpm docs:check`.

## Undefined Behavior

| Question                                                                | Current Evidence                                                     | Candidate Decision                                                                                        | Status |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| Should page metadata be schema-required?                                | Guidelines require fields, schema makes them optional.               | Keep schema permissive for generated/home pages, add a lint for authored pages if drift becomes frequent. | open   |
| Should docs/package list drift be automated?                            | Guidelines mention alignment; no automated drift check.              | Add a docs/release drift check under release-packaging or docs-site.                                      | open   |
| Which API docs are generated versus hand-authored?                      | TypeDoc writes `reference/api`; `reference/api.md` is hand-authored. | Mark generated directory ownership in docs guidelines.                                                    | open   |
| How much homepage customization is allowed?                             | `index.mdx` uses custom MDX/CSS.                                     | Keep homepage as the only splash exception unless another branded page is explicitly designed.            | open   |
| Should sidebar use `slug` instead of `link` for automatic title checks? | Current sidebar uses explicit `link` and labels.                     | Defer; manual labels are intentional for curated IA.                                                      | open   |

## Validation

- `openspec validate backfill-docs-site --strict` passed.
