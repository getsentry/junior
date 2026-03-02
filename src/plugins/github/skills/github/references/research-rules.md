# Research and Verification Rules

Use this file for cross-type rules. Then apply the matching type-specific file:
- `bug`: [issue-type-bug.md](issue-type-bug.md)
- `feature`: [issue-type-feature.md](issue-type-feature.md)
- `task`: [issue-type-task.md](issue-type-task.md)

## Source Priority

1. First-party repository evidence:
- Source code and tests
- Existing issues and PRs
- Release notes/changelog
- Project docs

2. First-party vendor docs for dependencies/services.

3. Reputable external sources only when needed.

## Verification Standard

- Treat statements as `verified` only when backed by direct evidence.
- Prefer at least two independent supporting signals for high-impact claims.
- If signals conflict, state the conflict and lower confidence.
- If evidence is missing, mark as `unknown`.

## Output Expectations

- Separate `Verified Facts`, `Likely`, and `Unknowns`.
- Include source links/paths for each verified fact.
- Use exact dates for timeline claims.
- Avoid absolute language when confidence is low.
- For `feature` issues, target a couple prior-art examples when available; if not found, explicitly say none were found.
