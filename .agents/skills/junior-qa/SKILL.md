---
name: junior-qa
description: Validate Junior changes by running the local Junior CLI from apps/example. Use for local client or agent QA, PR readiness, plugin CLI commands, skill/tool/prompt/plugin behavior, and behavior that tests do not cover well but can be exercised with `pnpm cli -- chat ...` or `pnpm cli -- <command> ...`.
---

Use the local Junior CLI to exercise behavior the test suite does not prove well.
The goal is to run the same app-facing path a developer or operator would use
from `apps/example`, inspect the result, and report concrete evidence.

Start by reading `specs/local-agent.md`. Read the relevant feature spec too when
the changed behavior is owned by one.

## Running the Local CLI

Use the repo wrapper so the command runs from `apps/example` with root and app
env loaded:

```sh
pnpm cli -- chat -p "Say exactly: junior qa smoke ok"
```

For agent behavior, prompts, skills, tools, and model-facing plugin behavior,
use `chat -p` or interactive `chat` with a prompt that naturally exercises the
change:

```sh
pnpm cli -- chat -p "<targeted prompt>"
```

For host or plugin CLI behavior, call the command directly through the same
wrapper:

```sh
pnpm cli -- memory search --scope personal --scope-key local:local-cli --limit 5
```

Use example app discovery probes when the change touches skill or plugin
discovery:

```sh
pnpm cli -- chat -p "/example-local confirm local QA discovery"
pnpm cli -- chat -p "/example-bundle-help"
```

Healthy startup usually logs `SOUL.md`, `WORLD.md`, loaded plugins, and
discovered skills. Treat those logs as useful evidence that the example app path
was exercised.

## Choosing a Probe

Pick the smallest local CLI run that demonstrates the changed behavior:

- Use exact-output prompts for simple agent routing or prompt-context checks.
- Use natural-language prompts when the behavior is an agent/tool workflow.
- Use direct plugin commands when the behavior is an operator CLI surface.
- Use interactive `pnpm cli -- chat` when continuity across turns matters.
- Do not use local CLI to claim Slack-only behavior, such as Slack formatting,
  delivery retries, reactions, files, or OAuth UI.

Automated tests, typechecks, linters, and evals are separate validation. They do
not replace local QA evidence from running the client or agent.

## Failure Handling

If local chat fails because credentials are missing or expired, refresh the
environment when appropriate with `pnpm dev:env`, then rerun the same command.
If Redis errors appear during ordinary local QA, check whether
`JUNIOR_STATE_ADAPTER=redis` was set; local chat normally defaults to memory
state.

If the model answer is too loose to prove the behavior, use a narrower prompt,
an exact-output prompt, interactive mode, or a direct plugin CLI command. If the
behavior cannot be exercised through the local client/agent, say local QA is
insufficient and name the runtime surface that still needs manual coverage.

## Reporting

Report:

- the exact `pnpm cli -- ...` commands run
- exit status and the key output that proves the behavior
- whether `apps/example` loaded the expected app/plugin/skill path
- whether local QA was sufficient, or what remains unproven locally

Keep any automated test/lint/typecheck/eval results in a separate validation
section so they are not confused with local QA.
