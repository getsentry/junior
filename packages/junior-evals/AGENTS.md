# Evals

- Pass paths, `-t`, and `--shard` directly after the `evals:<suite>` script.
  Do not use `pnpm exec vitest` or `--`.
- Local setup (once): `pnpm dev:env`, `docker compose up -d postgres redis`,
  and `cloudflared` on PATH. Behavioral and integration need Vercel Sandbox
  and a Quick Tunnel. Guardian, router, and classifiers need only AI Gateway.
- Do not bind env vars manually. The eval config loads repo env files.
- `VITEST_EVALS_REPLAY_MODE=replay` proves a run makes no live calls.
- CI setup and labels: `evals/github-actions.md`.

## Cases

- Guardian evals send exact `ToolActionProposal` objects. Set `tool` to the
  agent tool name, so `proposal()` uses the production builder.
- A test touches the product only through app-route inputs
  (`src/fixture/inputs.ts`), third-party APIs mocked with MSW, and results
  from the reporting API and the Slack mock.
- Assert wording-independent facts (reply counts, turn states, tool calls,
  reactions) directly, not stored rows or runtime objects. Judge wording with
  `toSatisfyJudge(RubricJudge, rubric({ pass, fail }))`.
- Do not check raw Slack Web API payloads or invent transcript or tool-call
  schemas. Improve `src/fixture/` instead.
- Put a case that needs a plugin in the suite (`src/suites/*.ts`) that has
  it. Do not set up the plugin in the test.
- Setup data goes through product store functions in `src/fixture/insert.ts`.
- `webSearch` is mocked and finds nothing by default. Use
  `mockWebSearchResults()` and `mockWebPages()` from `src/fixture/web.ts`.
- Use fake external targets. Do not change real provider resources.
- In `evals/scheduler/`, each production failure of an automation run has one
  realistic case that cites its issue. Extend it. Do not add a second case.
- `scripts/check-test-architecture.mjs` has a baseline. Lower an entry when
  you fix a file. Do not add entries.

## Recordings

- Evals replay model calls and web pages from Roach
  (`https://roach-proxy.getsentry.net`). Recordings are in its GCS bucket, not
  in git.
- Change recorded traffic, reachable origins, and value patterns only in
  `src/recording-rules.ts`.
- In CI, `scripts/network-jail.sh` refuses connections that skip the proxy.
  Send such a request through the proxy. Do not allow its host.
- Without `ROACH_TOKEN`, a run can only replay, and requests without a
  recording fail. With it, new requests go live once and are recorded. Only
  global setup reads it.
- Fix the first recording miss of a test. Later misses usually follow from it.
- Fix a value that changes on each run for all tests, in the fixture or as a
  `values` pattern in the rule, not in one test. Avoid slow patterns, such as
  `(a+)+`.
- Anyone who can make the same request can read a recording. Do not record
  private responses. Add a new CI credential to `SECRET_ENV`.
- Read `src/stable-setup.ts`, `src/eval-clock.ts`, and `src/fixture/ids.ts`
  before you add a new fix for unstable time, random values, or ids.
