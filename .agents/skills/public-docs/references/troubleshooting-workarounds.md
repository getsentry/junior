# Troubleshooting and Workarounds

## 1) Missing required frontmatter fields

Symptom:
- Page exists but fails docs quality expectations or review.

Checks:
1. Confirm `type`, `summary`, `prerequisites`, and `related` are present on new or heavily edited pages.
2. Ensure `type` is one of: `conceptual`, `tutorial`, `reference`, `troubleshooting`.

Fix:
- Add missing fields and keep values concise and actionable.

## 2) Page feels thin or outline-like

Symptom:
- Sections are mostly headings with bullets.

Checks:
1. Inspect each `##` section for at least brief explanatory prose.
2. Confirm the page answers "what / for whom / next step".

Fix:
- Add 2+ sentences around major list sections and tie points to user outcomes.

## 3) Tutorial lacks confidence checks

Symptom:
- Reader can follow steps but cannot confirm success.

Checks:
1. Look for a dedicated verify/check section.
2. Ensure commands have observable expected outcomes.

Fix:
- Add a concrete verification step and expected output description.

## 4) Broken or stale internal links

Symptom:
- Links 404 after page move or section rename.

Checks:
1. Search changed files for old slugs.
2. Check `astro.config.mjs` redirects for moved pages.

Fix:
- Update links and add redirects for deprecated routes.

## 5) Sidebar does not show new page

Symptom:
- Page exists but is not discoverable in nav.

Checks:
1. Verify `sidebar` entries in `astro.config.mjs`.
2. Confirm link path includes trailing slash style used locally.

Fix:
- Add sidebar item at the correct section and order.

## 6) Reference docs are too narrative

Symptom:
- API/config reader must scroll through long prose to find contract details.

Checks:
1. Confirm page starts with scope summary and contract/table/signature block.
2. Confirm conceptual explanation is brief.

Fix:
- Reorder to reference-first structure and keep conceptual detail short.

## 7) Generated API docs seem outdated

Symptom:
- Links or expected functions do not match current package surface.

Checks:
1. Review `starlightTypedoc` entry points in `astro.config.mjs`.
2. Confirm source exports under `packages/junior/src`.
3. Run `pnpm docs:build`.

Fix:
- Update entry points or exported symbols, then rebuild docs.

## 8) Docs checks pass locally but page quality is still weak

Symptom:
- No technical errors, but docs are unclear for new users.

Checks:
1. Run a reader-path review: "what is this, is this for me, what next?"
2. Confirm next-step links are explicit and not circular.

Fix:
- Rewrite intro and section transitions with explicit user intent and progression.
