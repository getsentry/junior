# Documentation

## Intent

Internal docs record intent and rules that the code cannot show. Agents and
maintainers read them before they change code. Every extra line costs context
and hides the rules that matter. Short docs are read, followed, and kept
current.

## Policy

- `README.md` is for people who find a package on GitHub or npm. npm always
  publishes it. Keep it to the purpose, install or setup, and a link to
  `junior.sentry.dev`. Do not put internal design in it.
- Internal notes for a directory go in `AGENTS.md` in that directory. Add one
  only when the directory has rules that one file does not show.
- An `AGENTS.md` states intent and policy:
  - why the module exists, what it owns, and what it does not own
  - invariants and boundaries, including things that must not happen
  - safety, privacy, delivery, and recovery rules that are easy to break
- Do not write feature descriptions, tool-by-tool behavior, step lists that
  repeat the code, schemas, test inventories, history, or rollout notes. The
  code, types, and tests own those.
- Put a fact that one symbol owns in the JSDoc of that symbol.
- Put procedures (how to run, record, or debug something) in a command table
  or a skill, not in prose.
- Say a rule once. Point to the owning doc instead of copying it.
- Name files, types, and functions. Do not explain how they work.
- Use short bullets. Use ASD-STE100 English and the words in
  `TERMINOLOGY.md`.
- An internal doc has at most 120 lines. `pnpm file-length:check` enforces
  this. Aim for less than 60.
- Change a doc only when intent, an invariant, or a boundary changes. Do not
  add a paragraph for each feature. When you add a rule, remove a rule that is
  stale.

## Exceptions

- Public product docs live in `packages/docs` and follow the `public-docs`
  skill.
- Skills follow the `skill-writer` skill.
