# github-code skill contract

## Intent

Guide evidence-first GitHub repository work from inspection through a reviewable result without loading command and packaging detail on every run.

## Behavioral contract

- Resolve and inspect the repository before acting.
- Preserve unrelated work; reject destructive Git operations except `--force-with-lease` pushes to branches Junior pushed or the requester named.
- Treat shallow clones as inspection checkouts; deepen before history work; never force-push around missing ancestry.
- Install dependencies with the lockfile frozen mode before verification when needed.
- Finish every code change with a pushed PR, without asking, unless the user opts out or asked for investigation only. Open it ready when work and checks are done; open a draft when work, checks, or decisions remain. An open scope question goes in the PR body, not in a stop.
- After each push to a branch with an open PR, check mergeability. Resolve conflicts without asking, by merging the PR base branch (usually the default branch). Never rebase for this. GitHub sends no event for a new conflict, and conflicted PRs get no new checks.
- Write conventional PR titles and short plain-English bodies; keep check results out of the PR body.
- Report exact validation and permission failures.

## Runtime architecture

- `SKILL.md`: always-on rules and reference router.
- `references/api-surface.md`: command and permission lookup.
- `references/workflow.md`: edit, verify, and PR packaging.
- `references/troubleshooting-workarounds.md`: failure recovery.

The GitHub plugin manifest owns runtime install, OAuth, and env setup. Do not move those into this skill.

## Triggers

Should trigger for implementation, source inspection, clone/fetch/branch work, commits, PRs, reviews, CI, and repository credential failures.

Should not trigger for issue-only ops, non-GitHub ticketing, product telemetry, or docs with no repository task.

## Validation

1. Run the repository skill validator.
2. Confirm all referenced files exist.
3. Confirm `SKILL.md` stays a router (workflow detail lives in references).
4. Confirm code-edit completion always opens a PR, and an open scope question does not stop it.

## Maintenance

Keep always-on policy in `SKILL.md`. Move syntax matrices, packaging steps, and failure tables to routed references. Delete duplicates instead of restating them.
