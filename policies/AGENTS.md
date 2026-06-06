# Agent Instructions

## Policy Scope

- Treat `policies/*.md` as repo-wide defaults, not architecture specs.
- Use `specs/*.md` for feature contracts, lifecycles, and system design.
- Add a policy only for recurring rules that should apply across the repo.
- Prefer updating an existing policy over creating an overlapping one.

## Policy Writing

- Follow `policies/policy-template.md`: Intent, Policy, Exceptions.
- Keep each policy short; state the default rule before exceptions.
- Reference related policies by exact path instead of duplicating them.
- Use examples only when the rule is likely to be misapplied without one.
- Keep `policies/code-comments.md` and `policies/interface-design.md` aligned.

## Editing Checks

- Run `pnpm exec prettier --write policies/<file>.md` for edited policy docs.
- Update affected specs, tests, or code comments when a policy changes behavior.
