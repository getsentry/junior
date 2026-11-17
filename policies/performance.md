# Performance

## Intent

A request, a Turn, or a dashboard page is slow when it waits on work that it
could start at once, when it starts too much work at once, or when it reloads
data that did not change. These rules keep that work small. A check enforces
each rule, so new code cannot drift from it.

## Policy

- Start independent work together. Do not `await` in a loop when a step does
  not need the result of the step before it. Collect the promises and await
  them with `Promise.all`. Check: oxlint `no-await-in-loop`.
- Bound fan-out over a list. Read many rows in one batched call first, such as
  one SQL query with `inArray` or `getStateValues` for state. When each item
  needs its own call, run the calls through a `p-limit` limiter:
  `const limit = pLimit(N)` and `list.map((item) => limit(() => work(item)))`.
  Use about 5 for provider APIs and about 8 for internal storage. Check: oxlint
  `junior/bounded-fan-out`.
- Use `for…of`, not `forEach`. A `forEach` callback hides `await`, `return`,
  and `break` from the loop. Check: oxlint `unicorn/no-array-for-each`.
- In the dashboard, refresh only the queries that a change touched. Build query
  keys with a key factory, such as `reviewItemListQueryKey`. Write a mutation
  response into the cache with `setQueryData`, and do not refetch it. When a
  change touches a family of queries, call the helper that owns that family,
  such as `invalidateConversationFeeds` or `invalidateReviewItemCollections`.
  Do not invalidate, refetch, reset, or remove a key with two or fewer parts,
  unless you pass `exact: true`. Check: dashboard oxlint `query-invalidation/no-broad-query-invalidation`.

- Keep the SQL work of hot API routes inside a budget. A budget counts the
  statements of one request, and its serial rounds: the longest chain of
  statements where each one waits on the one before. Integration tests measure
  it with `expectSqlBudget` from `packages/junior/tests/fixtures/sql-budget.ts`.
  The Postgres executor publishes each statement on the `junior:sql:statement`
  diagnostics channel, which the helper reads.
- Keep the API requests of the main dashboard pages inside a budget. Dashboard
  e2e specs measure a first page load with `expectRequestBudget` from
  `packages/junior-dashboard/e2e/request-budget.ts`.
- Set a new budget to the measured value. When a change uses less, lower the
  budget in the same change. Do not raise a budget to pass. Fix the code.

## Exceptions

- Await in a loop when each step needs the step before it: cursor pages,
  ordered writes, rate limits, or a stop at the first failure. Fan out with no
  limiter when a schema or a constant caps the list at a small size. In both
  cases, write the reason next to the code:
  `// oxlint-disable-next-line <rule> -- <reason>`. A fan-out reason names the
  cap.
- Invalidate a broad key only when the client cannot know which queries under
  it changed. Write the reason in a disable comment.
- `scripts/await-in-loop-baseline.json` lists the `no-await-in-loop` sites that
  existed when the rule was added. `tools/oxlint/await-in-loop.json` turns the
  rule off for those files. `pnpm await-in-loop:check` fails when a count goes
  up, and when a count goes down but its entry does not. Do not add entries.
  When you change a listed file, fix its sites and lower its entry.
