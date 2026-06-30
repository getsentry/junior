# junior-qa Skill Spec

## Intent

`junior-qa` teaches coding agents working on this repository how to QA Junior through the local chat CLI and `apps/example`. It exists to make local agent verification a normal part of implementation and review, especially for changes that are not Slack-specific.

## Scope

The skill covers:

- Local single-turn QA through `pnpm cli -- chat -p`.
- `apps/example` SOUL/WORLD loading and skill/plugin discovery checks.
- When local CLI proof is enough as smoke coverage and when to add integration tests, evals, or Slack-specific tests.
- Common failure modes for local QA, especially explicit Redis state adapter selection and model gateway network failures.

The skill does not replace:

- Typecheck/build validation.
- Focused tests for deterministic runtime behavior.
- Evals for model-facing contracts.
- Slack MSW/integration coverage for Slack-only contracts.

## Runtime Contract

Agents using the skill should:

1. Read `specs/local-agent.md` and the relevant changed feature spec.
2. Expect memory state for ordinary local QA unless `JUNIOR_STATE_ADAPTER` is explicitly set.
3. Use `apps/example` as the canonical local app fixture.
4. Prove a baseline exact-output CLI turn.
5. Probe app-level skill discovery with `/example-local`.
6. Probe plugin-bundled skill discovery with `/example-bundle-help`.
7. Add one narrow targeted prompt for the changed behavior.
8. Run the appropriate typecheck, test, or eval layer for the changed contract.
9. Report commands, final outputs or assertions, and remaining risk.

## Evidence

The workflow is grounded in the repository's local agent spec, CLI tests, integration tests, and verified local CLI runs. The proven QA commands load `apps/example`, discover the top-level example skill and bundled plugin skill, and exercise the shared agent reply path without Slack.

## Limitations

Local CLI QA proves the non-Slack local ingress and shared agent/runtime path. It does not prove Slack formatting, Slack retry delivery, channel/DM routing, file uploads, reactions, mention behavior, or Slack API payload contracts.

Network-dependent local QA can fail when the model gateway is unavailable in the current environment. Redis-dependent local QA can fail when `JUNIOR_STATE_ADAPTER=redis` points at an unavailable Redis service; memory state is the default QA mode unless durable state is under test.

## Maintenance

Update this skill when:

- `specs/local-agent.md` changes the CLI contract.
- `apps/example` changes its local skill or plugin fixture names.
- The CLI command shape changes.
- The repository introduces another canonical local app fixture for QA.
