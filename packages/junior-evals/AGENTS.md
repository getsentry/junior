# Evals

Evals test agent-facing behavior through the real runtime. `policies/evals.md`
owns the suite policy (integration, behavioral, guardian, router), the rubric
rules, and the scenario limits. This file adds the harness rules.

## Layer Boundaries

- `evals/integration/**`: full-runtime cases that must never regress. Hard
  pass/fail. Prefer fixed assertions.
- `evals/<area>/` (`conversation`, `agent`, or a feature or suite directory):
  behavioral cases. Score-gated in CI.
- `evals/guardian/**`: `describeEval()` with `guardianEvals`. Send exact
  `ToolActionProposal` objects and assert only `allow` / `ask` / `deny`. Set
  `tool` to the agent tool name, so `proposal()` builds it with the production
  builder (`src/guardian-tools.ts`).
- `evals/router/**`: `describeEval()` with `routerEvals`. Assert the exact
  model profile and reasoning level.
- Slack HTTP payload contracts and isolated logic belong in
  `packages/junior/tests/`, not here. `pnpm lint` enforces this.

## Agent Test Fixture

Cases that run the agent use `src/fixture/`. Issue #2001 has the full contract.

- The agent is one unit. Do not mock the model or any Junior-owned module.
- A test touches the product in three places only:
  1. Inputs through app routes (`src/fixture/inputs.ts`): Slack events, web
     messages, heartbeat, GitHub webhooks, App Home clicks, and OAuth callbacks.
  2. Mocked third-party APIs through MSW.
  3. Call results from Junior's reporting API and the Slack mock: replies,
     tool calls, reactions, statuses, thread titles, files, and turn states.
- `run()` starts a Conversation, `continue()` sends the next input, and
  `fork()` calls the forks route. A call returns when the agent is idle and
  fails after 60 seconds.
- `agent(options)` takes `createApp()` options and replaces suite defaults key
  by key. Tests may import the public `@sentry/junior` API and plugin
  packages, not runtime internals under `@/`.
- The default agent has no experimental feature. A test turns on what it needs.
- A suite (`src/suites/*.ts`) is a Vitest project with default agent options
  and host environment. Put a case that needs a plugin in the suite that has
  it. Do not set up the plugin in the test.
- `history` loads earlier turns as stored data and never runs the agent.
  `src/fixture/history.eval.ts` checks that it writes the same rows as real
  turns.
- Setup data goes through `src/fixture/insert.ts`, which uses product store
  functions. Add an insert function for a new kind of setup data.
- Put an input, read, or assertion that many evals need in `src/fixture/`.
- Assert facts that do not depend on wording (reply counts, turn states, tool
  calls, reactions) directly, not stored rows or runtime objects. Judge
  wording with `toSatisfyJudge(RubricJudge, rubric({ pass, fail }))`.
- `scripts/check-test-architecture.mjs` enforces these rules. Lower a baseline
  entry when you fix a file. Do not add entries.

## Authoring Rules

- One primary behavior per case. `describe()` owns the area. Name cases
  `when <trigger>, <outcome>`.
- Keep `pass` and `fail` as short lists of observable conditions. Add `fail`
  only for a real regression or unsafe side effect.
- Use fake external targets. Do not mutate real provider resources.
- `webSearch` is always mocked and finds nothing by default. Use
  `mockWebSearchResults()` and `mockWebPages()` from `src/fixture/web.ts`.
  Other URLs go through Roach.
- File names are short behavior nouns. Shared setup goes in `helpers.ts`.
- Do not, in eval files:
  - import `@/chat/slack/*` or use the MSW Slack helpers
  - check raw Slack Web API payloads
  - invent transcript, event-log, or tool-call schemas; improve the fixture
  - check internals, such as sandbox ids, unless they are the behavior

## Recordings

- Evals replay model calls and web pages from Roach, the shared recording
  service at `https://roach-proxy.getsentry.net`
  ([`getsentry/roach`](https://github.com/getsentry/roach)). Recordings are in
  its GCS bucket, not in git. `src/roach/` is a copy of its client.
- `src/recording-rules.ts` lists the recorded traffic and the only origins
  that evals can reach. To record more, reach a new site, or add a value
  pattern, edit only that file.
- All eval HTTP traffic must go through the proxy. In CI,
  `scripts/network-jail.sh` rejects other connections. If a request fails with
  a refused connection, send it through the proxy. Do not allow its host in the
  firewall.
- `ROACH_TOKEN` is the write token. With it, a run uses `auto` mode and records
  new requests, which go live once. Without it, a run can only `replay`, and
  requests without a recording fail. CI passes the token to eval runs. Only
  global setup reads it.
- Each run prints `[evals] Recordings: ...` and the first miss of each test.
  Fix the first miss; later misses usually follow from it.
- Fix a value that changes on each run for all tests, in the fixture or in
  `values` of the rule, not in one test. For ids and times that only the
  product makes, add a pattern to `values`. The proxy keys the request without
  the value and gives a replayed response the value of the current run. Avoid
  slow patterns, such as `(a+)+`.
- Add a new CI credential to `SECRET_ENV` in `src/recording-rules.ts`.
  Recordings are public to anyone who can make the same request. Do not record
  private responses.
- `src/stable-setup.ts`, `src/eval-clock.ts`, and `src/fixture/ids.ts` keep
  time, random values, and ids stable. Read them before you add a new fix.

## Commands

Pass paths, `-t`, and `--shard` directly after the script. Do not use
`pnpm exec vitest` or `--`.

| Task                | Command                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| Local setup (once)  | `pnpm dev:env`, `docker compose up -d postgres redis`, `cloudflared` on PATH |
| Run a suite         | `pnpm --filter @sentry/junior-evals evals:<suite>`                           |
| One file or case    | `... evals:<suite> path/to/x.eval.ts -t "case"`                              |
| Prove no live calls | `VITEST_EVALS_REPLAY_MODE=replay ... evals:<suite>`                          |
| Harness tests       | `pnpm --filter @sentry/junior-evals test`                                    |

- Do not bind env vars manually. The eval config loads repo env files.
- Behavioral and integration need Vercel Sandbox and a Quick Tunnel. Guardian
  and router need only AI Gateway access.
- CI setup and labels: `evals/github-actions.md`.
