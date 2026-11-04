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
- The repo root `AGENTS.md` is the only one. Do not add one in a directory.
  Directory docs grew with each patch and repeated what the code shows.
- Code defines its own design. Put an invariant, a boundary, or a rule that is
  easy to break in a comment next to the code that it governs (see
  `code-comments.md`). Put a repo-wide rule in a policy.
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
- Core docs (`AGENTS.md`, `README.md`, and policies) have at most 120 lines.
  Agents read them before a change, so aim for less than 60.
- Reference docs that agents look up, such as `TELEMETRY.md` and setup guides,
  can be long. Keep them current and free of repeated text. `TELEMETRY.md` and
  `TERMINOLOGY.md` have at most 1,000 lines.
- `pnpm file-length:check` enforces these limits and the single `AGENTS.md`.
- Change a doc only when intent, an invariant, or a boundary changes. Do not
  add a paragraph for each feature. When you add a rule, remove a rule that is
  stale.

## Exceptions

- Public product docs live in `packages/docs` and follow the `public-docs`
  skill.
- Skills follow the `skill-writer` skill.
