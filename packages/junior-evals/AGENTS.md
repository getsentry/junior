# Evals

`policies/evals.md` owns the suites, rubric rules, and scenario limits. This
file adds the harness rules.

## Layers

- `evals/integration/**`: full-runtime cases that must never regress. Hard
  pass/fail. Prefer fixed assertions.
- `evals/<area>/` (`conversation`, `agent`, or a feature directory):
  behavioral cases. Score-gated in CI.
- `evals/guardian/**`: `describeEval()` with `guardianEvals`. Send exact
  `ToolActionProposal` objects and assert only `allow` / `ask` / `deny`. Set
  `tool` to the agent tool name, so `proposal()` uses the production builder
  (`src/guardian-tools.ts`).
- `evals/router/**`: `routerEvals`. Assert the exact model profile and
  reasoning level.
- `evals/classifiers/**`: one harness per classifier, such as
  `reviewItemReplyEvals`. Assert the exact choice.
- Slack HTTP payload contracts and isolated logic belong in
  `packages/junior/tests/`. `pnpm lint` enforces this.

## Agent fixture

Cases that run the agent use `src/fixture/` (contract: issue #2001).
`scripts/check-test-architecture.mjs` enforces these rules. Lower a baseline
entry when you fix a file. Do not add entries.

- The agent is one unit. Do not mock the model or any Junior-owned module.
- A test touches the product in three places only:
  1. Inputs through app routes (`src/fixture/inputs.ts`).
  2. Third-party APIs mocked with MSW.
  3. Results from Junior's reporting API and the Slack mock.
- `run()` starts a Conversation, `continue()` sends the next input, and
  `fork()` calls the forks route. Each returns when the agent is idle and
  fails after 60 seconds.
- `agent(options)` takes `createApp()` options and replaces suite defaults key
  by key. Import the public `@sentry/junior` API and plugin packages, not
  runtime internals under `@/`.
- The default agent has no experimental feature. A test turns on what it needs.
- A suite (`src/suites/*.ts`) is a Vitest project with default agent options
  and host environment. Put a case that needs a plugin in the suite that has
  it. Do not set up the plugin in the test.
- `history` loads earlier turns as stored data and never runs the agent.
  `src/fixture/history.eval.ts` checks that it writes the same rows as real
  turns.
- Setup data goes through product store functions in `src/fixture/insert.ts`.
  Put an input, read, or assertion that many evals need in `src/fixture/`.
- Assert wording-independent facts (reply counts, turn states, tool calls,
  reactions) directly, not stored rows or runtime objects. Judge wording with
  `toSatisfyJudge(RubricJudge, rubric({ pass, fail }))`.

## Authoring

- One primary behavior per case. `describe()` owns the area. Name cases
  `when <trigger>, <outcome>`.
- Keep `pass` and `fail` as short lists of observable conditions. Add `fail`
  only for a real regression or unsafe side effect.
- Use fake external targets. Do not change real provider resources.
- `webSearch` is mocked and finds nothing by default. Use
  `mockWebSearchResults()` and `mockWebPages()` from `src/fixture/web.ts`.
  Other URLs go through Roach.
- File names are short behavior nouns. Shared setup goes in `helpers.ts`.
- In eval files, do not import `@/chat/slack/*`, use the MSW Slack helpers,
  check raw Slack Web API payloads, invent transcript or tool-call schemas
  (improve the fixture), or check internals that are not the behavior.

## Recordings

- Evals replay model calls and web pages from Roach
  (`https://roach-proxy.getsentry.net`,
  [`getsentry/roach`](https://github.com/getsentry/roach)). Recordings live in
  its GCS bucket, not in git. `src/roach/` is a copy of its client.
- `src/recording-rules.ts` is the only place to list recorded traffic,
  reachable origins, and value patterns.
- All eval HTTP traffic goes through the proxy. In CI,
  `scripts/network-jail.sh` rejects other connections. Fix a refused
  connection by routing it through the proxy, not by allowing its host.
- `ROACH_TOKEN` is the write token. With it, a run uses `auto` mode and
  records new requests once. Without it, a run can only `replay`, and requests
  without a recording fail. Only global setup reads it.
- Each run prints `[evals] Recordings: ...` and the first miss of each test.
  Fix the first miss; later misses usually follow from it.
- Fix a value that changes on each run for all tests, in the fixture or in
  the rule's `values`, not in one test. For ids and times that only the
  product makes, add a `values` pattern; the proxy keys without it and replays
  the current run's value. Avoid slow patterns, such as `(a+)+`.
- Add a new CI credential to `SECRET_ENV` in `src/recording-rules.ts`.
  Anyone who can make the same request can read a recording, so do not record
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
- Behavioral and integration need Vercel Sandbox and a Quick Tunnel. Guardian,
  router, and classifiers need only AI Gateway access.
- CI setup and labels: `evals/github-actions.md`.
