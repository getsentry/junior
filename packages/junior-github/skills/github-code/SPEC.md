# github-code skill contract

## Intent

Guide evidence-first GitHub repository work from inspection through a reviewable result without duplicating command and troubleshooting detail in runtime context.

## Behavioral contract

- Resolve and inspect the repository before acting.
- Preserve unrelated work and reject destructive Git operations.
- Treat shallow clones as inspection checkouts; fetch/deepen before history-dependent operations and never force-push around missing ancestry.
- Install repository dependencies with the detected package manager's locked/frozen mode before verification when dependencies are absent.
- For every completed repository edit, create or update a pushed PR unless the user explicitly opts out; default new PRs to draft while honoring explicit ready-for-review instructions.
- Report exact validation and permission failures without claiming partial work is complete.

## Runtime architecture

- `SKILL.md`: compact workflow and decision rules.
- `references/api-surface.md`: command and permission lookup.
- `references/troubleshooting-workarounds.md`: failure recovery.

Do not move provider runtime installation, OAuth, or environment setup into this skill; the GitHub plugin manifest owns those concerns.

## Trigger expectations

Should trigger for implementation, source inspection, clone/fetch/branch work, commits, PRs, reviews, CI, and repository credential failures.

Should not trigger for GitHub issue-only operations, non-GitHub ticketing, product telemetry, or general product documentation with no repository task.

## Validation

After material edits:

1. Run the repository skill validator.
2. Run formatting or package checks applicable to changed Markdown.
3. Confirm all referenced files exist.
4. Confirm code-edit completion defaults to a draft PR.
5. Confirm dependency installation and shallow-history recovery do not permit lockfile mutation or force-push shortcuts.

## Maintenance

Keep workflow policy in `SKILL.md`; move syntax matrices and failure details to the routed references. Remove duplicated rules rather than restating them across sections.
