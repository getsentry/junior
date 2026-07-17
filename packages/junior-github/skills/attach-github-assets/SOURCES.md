# Sources

## Inventory

- `intercom/2x-skills@59213af`, `plugins/pr-tools/skills/attach-github-assets/SKILL.md` — upstream runtime intent and supported use cases; primary source; high confidence; MIT.
- `intercom/2x-skills@59213af`, `plugins/pr-tools/skills/attach-github-assets/scripts/upload.sh` — upstream endpoint, MIME mapping, and response contract; primary implementation source; high confidence; MIT.
- `intercom/2x-skills@59213af`, `plugins/pr-tools/LICENSE` — upstream copyright and license notice; authoritative legal source; high confidence.
- `packages/junior-github/src/index.ts` — local GitHub credential and egress boundary; authoritative local source; high confidence.
- `packages/junior-github/skills/github-code/SKILL.md` — local repository targeting and credential guidance; authoritative local convention; high confidence.
- GitHub REST API documentation — no documented user-attachment upload operation found; official source; medium confidence for absence.

## Decisions

- **Adopted:** preserve the upstream one-file-per-upload behavior, supported formats, markdown output, and upload endpoint.
- **Adopted:** preserve the upstream MIT license in the skill directory as explicitly required.
- **Replaced:** direct `gh auth token` access with Junior's host-managed, repository-scoped installation credential injection so credentials never enter script output or files.
- **Replaced:** numeric repository-id override with explicit `owner/repo`; the script resolves the id through authenticated `gh api`.
- **Narrowed:** automatic activation requires a concrete local path and GitHub destination.
- **Deferred:** live upload verification because it would create an external GitHub asset; deterministic mocked validation is sufficient for implementation checks.

## Coverage

- Happy path: local image/video, repository resolution, successful URL extraction.
- Failures: missing path, missing file, unsupported type, unresolved repository, non-201 response, missing URL.
- Safety: no guessed paths, no remote URLs, no token retrieval, one upload per invocation.
- Portability: the skill is intentionally Junior GitHub-plugin-specific; relative script paths use the skill working directory supplied by `loadSkill`.

## Stopping Rationale

Further retrieval was low-yield: the upstream implementation, local plugin credential boundary, local skill conventions, tests, and package registration behavior cover the runtime contract. The upload endpoint remains undocumented by GitHub, so the implementation records that limitation rather than inventing a public API guarantee.
