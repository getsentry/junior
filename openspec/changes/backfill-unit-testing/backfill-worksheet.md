# Unit Testing Backfill Worksheet

## Canonical Spec

- New spec: `unit-testing`

## Local Artifacts Reviewed

- `specs/unit-testing.md`
- `specs/testing.md`
- `packages/junior/vitest.config.ts`
- `packages/junior/tests/unit/**`

## External Sources

- Vitest mocking docs: https://vitest.dev/guide/mocking.html
- Vitest config docs: https://vitest.dev/config/

## Undefined Behavior

| Question                                            | Current Evidence                                           | Candidate Decision                                            | Status |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| Should broad legacy unit tests move to integration? | Some runtime seam tests live under `tests/unit`.           | Migrate opportunistically when behavior changes.              | open   |
| Should prompt prose unit assertions be deleted?     | Prompt tests exist; taxonomy discourages prose assertions. | Replace with eval/integration behavior coverage when touched. | open   |
| Should over-mocking be automatically enforced?      | No generic detector.                                       | Rely on review unless repeated failures justify tooling.      | open   |

## Validation

- `openspec validate backfill-unit-testing --strict` passed.
