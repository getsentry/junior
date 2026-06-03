# Specs Instructions

## Scope

- Applies to files under `specs/`.
- `security-policy.md` is policy-style.
- All other canonical specs are implementation contracts.

## Naming Rules

- Canonical specs: concise kebab-case names. The `-spec` suffix is allowed but not required.
- Policy specs: `*-policy.md`.
- Spec indexes: `index.md`.
- Historical/superseded docs: `specs/archive/**`.

## Required Metadata

- Every non-policy spec must include this section near the top:

```md
## Metadata

- Created: YYYY-MM-DD
- Last Edited: YYYY-MM-DD
```

- Update `Last Edited` for every spec edit.
- Keep dates absolute and ISO (`YYYY-MM-DD`).
- Start new specs from `specs/spec-template.md`.

## Section Shape

- Use this order for canonical specs:

1. `Purpose` (or `Intent` for testing specs)
2. `Scope`
3. `Non-Goals`
4. Contracts and behavior details
5. Failure model / invariants
6. Observability
7. Verification
8. Related specs

## Canonical vs Archive

- Canonical specs describe current behavior only.
- Archive docs preserve history; they are non-normative.
- If archive and canonical content conflict, canonical wins.

## Edit Rules

- Keep links relative inside `specs/`.
- When renaming or moving specs, update:
  - `specs/index.md`
  - `AGENTS.md` known-spec references
  - all in-repo links to old paths
- Remove stale file paths and stale runtime terminology.

## Quality Bar

- Prefer concise, explicit contracts over narrative.
- Use concrete file paths and exact identifiers when referencing code behavior.
- Do not keep speculative future-state text in canonical sections.

## Validation

- Run:

```bash
pnpm typecheck
pnpm run test:slack-boundary
pnpm skills:check
pnpm test
```

- Optional drift checks:

```bash
rg -n "getBotDeps|setBotDepsForTests|resetBotDepsForTests|SentryCredentialBroker" specs
```
