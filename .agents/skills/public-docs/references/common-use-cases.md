# Common Use Cases

## 1) Create a new tutorial page

Request pattern:
- "Add a setup guide"
- "Write a quickstart for X"

Execution:
1. Place page under the most relevant section in `src/content/docs`.
2. Use `type: tutorial` and include `summary`, `prerequisites`, `related`.
3. Include explicit outcome, setup steps, and a verification step.
4. Link to next operational/reference docs.

Done criteria:
- A reader can follow steps end to end and confirm success.

## 2) Convert an outline into reader-ready conceptual docs

Request pattern:
- "Turn this rough draft into proper docs"
- "Make this page clearer for external users"

Execution:
1. Keep one core question per section.
2. Add explanatory prose around lists.
3. Remove internal-only jargon unless defined.
4. Add "when to use / when not to use" guidance.

Done criteria:
- Reader can quickly decide whether the feature applies to them.

## 3) Improve an existing reference page

Request pattern:
- "Update config docs"
- "Clarify API behavior"

Execution:
1. Keep scope summary near the top.
2. Use signature/table-first structure.
3. Keep examples minimal and valid.
4. Add constraints/caveats section if behavior is strict.

Done criteria:
- Page supports fast lookup without narrative bloat.

## 4) Add troubleshooting content for recurring failures

Request pattern:
- "Document common errors"
- "Add runbook for failing setup"

Execution:
1. Organize by symptom.
2. Place first checks in the first screenful.
3. Include recovery order and escalation links.
4. Include observable checks after each fix.

Done criteria:
- Reader can isolate cause quickly and recover with confidence.

## 5) Rework docs information architecture

Request pattern:
- "Move this page"
- "Reorganize section nav"

Execution:
1. Update content paths in `src/content/docs`.
2. Update `sidebar` links in `astro.config.mjs`.
3. Add or update redirects for moved routes.
4. Verify internal links in edited pages.

Done criteria:
- Old links still resolve and new nav path is discoverable.

## 6) Prepare docs for release-quality polish

Request pattern:
- "Final docs QA pass"
- "Make this read like Sentry/Vercel docs"

Execution:
1. Tighten language to plain, direct user outcomes.
2. Ensure each page has a purpose statement and next-step links.
3. Remove duplicated content across sibling pages.
4. Run `pnpm docs:check` and `pnpm docs:build` for release confidence.

Done criteria:
- Docs are consistent, scannable, and operationally accurate.
