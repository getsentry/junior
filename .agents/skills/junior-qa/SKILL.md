---
name: junior-qa
description: Validate Junior changes through local app-facing paths. Use for local client or agent QA, dashboard mock reporting UI QA, PR readiness, plugin CLI commands, skill/tool/prompt/plugin behavior, and behavior that tests do not cover well but can be exercised with `pnpm cli -- chat ...`, `pnpm cli -- <command> ...`, or `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev`.
---

Use the local Junior CLI to exercise behavior the test suite does not prove well.
The goal is to run the same app-facing path a developer or operator would use
from `apps/example`, inspect the result, and report concrete evidence.

Start by reading `specs/local-agent.md`. Read the relevant feature spec too when
the changed behavior is owned by one.

## Running the Local CLI

Use the repo wrapper so commands run from `apps/example` with root and app env
loaded. Pick the command and prompt that exercise the changed behavior; do not
treat any example prompt here as the required QA:

```sh
pnpm cli -- chat -p "<targeted prompt>"
```

For agent behavior, prompts, skills, tools, and model-facing plugin behavior,
use `chat -p` or interactive `chat` with a prompt that naturally exercises the
change. A trivial exact-output prompt is only useful when the requested check is
limited to proving the local runner starts and delivers one response.

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

## Dashboard UI QA

For dashboard UI changes that depend on reporting payload shape, use the typed
mock reporting overlay before relying on ad-hoc local conversations:

```sh
JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev
```

Then open the dashboard in a browser and exercise the relevant conversation,
transcript, search, or conversation stats surface. The mock overlay returns
read-only `@sentry/junior/reporting` conversation API-shaped data, including
dashboard QA edge cases such as activity-only tool rows and inverted tool
timestamps. It also includes an advisor tool call/result paired with advisor
subagent activity so transcript rendering can be checked against nested tool
activity without manufacturing a live agent run. Use it when a UI change needs
deterministic reporting records that are hard to produce through a live local
chat. Plugin report data is pass-through from the configured reporting provider
and needs separate validation.

Do not treat mock dashboard data as proof of runtime ingestion, Slack delivery,
credential behavior, or model behavior. Pair it with local CLI or integration
tests when the changed contract crosses those boundaries.

## Choosing a Probe

Pick the smallest local CLI run that demonstrates the changed behavior:

- Prefer a targeted prompt or direct CLI command tied to the modified feature.
- Use exact-output prompts for simple agent routing or prompt-context checks.
- Use natural-language prompts when the behavior is an agent/tool workflow.
- Use direct plugin commands when the behavior is an operator CLI surface.
- Use interactive `pnpm cli -- chat` when continuity across turns matters.
- Use dashboard mock reporting when the behavior is dashboard rendering,
  filtering, search, or metrics over reporting API payloads.
- Do not use local CLI to claim Slack-only behavior, such as Slack formatting,
  delivery retries, reactions, files, or OAuth UI.

Automated tests, typechecks, linters, and evals are separate validation. They do
not replace local QA evidence from running the client or agent.

## OAuth Flow QA (MCP and Plugin)

Junior has two OAuth pause/resume flows, both resumed by HTTP callbacks into a
Slack thread:

- Plugin (non-MCP) OAuth: sandbox egress `auth_required` signal resumes via
  `/api/oauth/callback/<provider>`. In `apps/example` the `sentry` plugin is
  the OAuth-manifest provider (`SENTRY_CLIENT_ID`/`SENTRY_CLIENT_SECRET`).
- MCP OAuth: a remote MCP server 401 challenge resumes via
  `/api/oauth/callback/mcp/<provider>`. In `apps/example` the `linear`,
  `notion`, and `hex` plugins use remote MCP URLs.

The local CLI cannot exercise the pause or the resume: the local runner sets
`authorizationFlowMode: "disabled"`, so an auth challenge ends the turn with a
terminal authorization failure instead of a private link plus `pendingAuth`.
Local chat only proves that terminal surface, for example:

```sh
pnpm cli -- chat -p "Use the linear skill to list Linear teams."
```

Expect a reply reporting that authorization failed, with no OAuth link.

Use the integration tests as the deterministic check for resume behavior:

```sh
pnpm --filter @sentry/junior exec vitest run tests/integration/oauth-callback-slack.test.ts
pnpm --filter @sentry/junior exec vitest run tests/integration/mcp-oauth-callback-slack.test.ts tests/integration/mcp-auth-runtime-slack.test.ts
```

For SQL conversation storage changes, verify the resumed turn rebuilds context
from SQL, not `thread-state` mirrors: conversation context must hydrate from
`junior_conversation_messages` (`hydrateConversationMessages`) and pi history
from `junior_agent_steps` (`loadProjection`). In those tests, transcripts
seeded only into `thread-state` must also be persisted to SQL
(`persistConversationMessages`) before the callback runs, and the resumed
agent-run input `conversationContext` must contain the SQL-seeded messages.

## Failure Handling

If local chat fails because credentials are missing or expired, refresh the
environment when appropriate with `pnpm dev:env`, then rerun the same command.
If local chat fails with a `junior_conversation_messages` or
`junior_agent_steps` query error, the local Postgres schema predates the SQL
conversation storage cutover; run `pnpm cli -- upgrade`, then rerun.
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
- for dashboard mock QA, the dev-server command, URL, mock conversation or page
  inspected, and the visible UI evidence
- exit status and the key output that proves the behavior
- whether `apps/example` loaded the expected app/plugin/skill path
- whether local QA was sufficient, or what remains unproven locally

Keep any automated test/lint/typecheck/eval results in a separate validation
section so they are not confused with local QA.
