# High-Quality Issue Examples

Use examples to shape structure and clarity, not to copy wording.

## Example links

- Sentry JavaScript: https://github.com/getsentry/sentry-javascript/issues/19529

## What to emulate

- Title is specific and scannable.
- Summary explains user-visible problem in one short paragraph.
- Evidence is concrete (logs, repro steps, references).
- Scope/impact is explicit.
- Unknowns are called out instead of guessed.
- Acceptance criteria are testable and check-boxed.

## Negative calibration

- `getsentry/sentry-mcp#817` is a calibration anti-pattern only.
- Do not mirror overlong issue bodies.
- Do not present speculative fixes as certain.

## How to apply in `/gh-issue`

1. Build content from the type-specific template selected by `issue-template.md`.
2. Run `issue-quality-checklist.md` before posting.
3. If important sections are missing, add them before create/update.
4. Keep it concise and within title/body caps.
