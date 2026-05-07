# Research and Verification Rules

Cross-type research standards. Apply alongside the matching type-specific guide:

- `bug`: [issue-bug.md](issue-bug.md)
- `feature`: [issue-feature.md](issue-feature.md)
- `task`: [issue-task.md](issue-task.md)

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

- Research depth should not translate into verbose issue output. The issue should be terse; research justifies what goes in, not how much.
- Clearly distinguish verified facts from unknowns. Weave evidence naturally into the issue rather than forcing separate sections.
- Include source links/paths inline for verified facts.
- Use exact dates for timeline claims.
- Avoid absolute language when confidence is low.
- For `feature` issues, include prior-art examples when found and relevant; omit the section entirely if none exist.
