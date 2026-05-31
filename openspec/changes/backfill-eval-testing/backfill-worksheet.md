# Eval Testing Backfill Worksheet

## Canonical Spec

- New spec: `eval-testing`

## Local Artifacts Reviewed

- `specs/eval-testing.md`
- `specs/testing.md`
- `policies/evals.md`
- `packages/junior-evals/README.md`
- `packages/junior-evals/package.json`
- `packages/junior-evals/vitest.evals.config.ts`
- `packages/junior-evals/evals/helpers.ts`
- `packages/junior-evals/evals/behavior-harness.ts`
- `packages/junior-evals/evals/**/*.eval.ts`

## External Sources

- Vitest config docs: https://vitest.dev/config/
- Vercel AI Gateway docs: https://vercel.com/docs/ai-gateway/models-and-providers
- MSW Node integration docs: https://mswjs.io/docs/integrations/node

## Undefined Behavior

| Question                                                    | Current Evidence                                 | Candidate Decision                                      | Status |
| ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- | ------ |
| Should eval case names map one-to-one to spec requirements? | Existing names are partially historical.         | Use the migration map before renames.                   | open   |
| How should flake budget be enforced?                        | Evals have timeout and harness bootstrap checks. | Add eval reliability policy if flaky failures recur.    | open   |
| Should all tool evidence be user-visible?                   | Some rubrics inspect tool traces.                | Allow only where traces prove a real behavior boundary. | open   |
| How are credentials refreshed locally?                      | README points to env pull/dev env workflows.     | Keep reporting missing credentials explicitly.          | open   |

## Validation

- `openspec validate backfill-eval-testing --strict` passed.
