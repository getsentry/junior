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
  needs its own call, use `mapBounded(list, work)` from
  `packages/junior/src/chat/fan-out.ts`. It runs `FAN_OUT_CONCURRENCY` calls
  at once. Plugins use `pLimit(N).map(list, work)`. Share one `pLimit`
  limiter only when several lists must use one cap. Use a lower cap only for
  a provider rate limit, and name its reason. A list whose length the code
  fixes needs no limiter: an array literal, `as const`, a tuple type written
  on the binding, or `list.slice(0, MAX)` with a constant `MAX`. Check: oxlint
  `junior/bounded-fan-out` and `junior/prefer-map-bounded`.
- Use `for…of`, not `forEach`. A `forEach` callback hides `await`, `return`,
  and `break` from the loop. Check: oxlint `unicorn/no-array-for-each`.
- In the dashboard, refresh only the queries that a change touched. Build query
  keys with a key factory, such as `inboxItemListQueryKey`. Write a mutation
  response into the cache with `setQueryData`, and do not refetch it. When a
  change touches a family of queries, call the helper that owns that family,
  such as `invalidateConversationFeeds` or `invalidateInboxItemCollections`.
  Do not invalidate, refetch, reset, or remove a key with two or fewer parts,
  unless you pass `exact: true`. Check: dashboard oxlint `query-invalidation/no-broad-query-invalidation`.
- In the dashboard, do not poll a query with `refetchInterval`. `/api/versions`
  tells the client which reads changed. A read that must poll disables the
  rule on its line with the reason. Check: dashboard oxlint
  `query-invalidation/no-refetch-interval`.
- Keep the SQL work of hot API routes inside a budget. A budget counts the
  statements of one request, and its serial rounds: the longest chain of
  statements where each one waits on the one before. Integration tests measure
  it with `expectSqlBudget` from `packages/junior/tests/fixtures/sql-budget.ts`.
  The helper reads the `orchestrion:pg:*` tracing channels. These are the
  channels that Sentry's Postgres spans use. Tests inject them into `pg` with
  `packages/junior/tests/fixtures/pg-tracing-hook.ts`, so runtime code has no
  extra wrapper.
- Do not read a big table in full on a hot API route. Integration tests check
  the plan of each statement with `expectNoFullScan` from the same file. It
  fails when a plan reads a table in its `BIG_TABLES` list with no index
  condition. A known full scan with a fix on the way gets a named `allowed`
  entry with a reason. An entry that matches nothing fails, so the fix
  removes it.
- Keep the estimated plan cost of each statement of a polled API route inside
  a budget. Integration tests check it with `expectPlanCost` from the same
  file. A statement that does work for each item of a list, such as one
  correlated subquery for each ID, costs more before the test data is big
  enough to make it slow. Set the max to about 1.5 times the measured cost.
- Keep the JSON body of hot API routes inside a size budget. A budget holds
  the size of the largest item of a list. A nested list with no cap on its
  count gets its own budget. Integration tests measure it with
  `expectResponseBudget` from `packages/junior/tests/fixtures/response-budget.ts`.
  Seed the fields at their max lengths, so the budget holds for real data.
- Keep the API requests of the main dashboard pages inside a budget. Dashboard
  e2e specs measure a first page load with `expectRequestBudget` from
  `packages/junior-dashboard/e2e/request-budget.ts`. Each primary nav route
  needs one. Check: `pnpm nav-request-budgets:check`.
  `scripts/nav-request-budget-exceptions.mjs` lists the routes without one and
  why. Do not add entries.
- Keep the first load of each dashboard UI shell inside a gzip budget.
  `scripts/dashboard-bundle-size-baseline.json` holds the size on `main`. A
  change that grows the first load updates it, and may grow it at most 2%.
  Check: `pnpm dashboard-bundle-size:check`.
- Set a new budget to the measured value. When a change uses less, lower the
  budget in the same change. Do not raise a budget to pass. Fix the code.

## Exceptions

- Await in a loop when each step needs the step before it: cursor pages,
  ordered writes, rate limits, or a stop at the first failure. Fan out with no
  limiter when a schema caps the list at a small size and no type can say
  so. In both cases, write the reason next to the code:
  `// oxlint-disable-next-line <rule> -- <reason>`. A fan-out reason names the
  cap.
- Invalidate a broad key only when the client cannot know which queries under
  it changed. Write the reason in a disable comment.
- `scripts/await-in-loop-baseline.json` lists the `no-await-in-loop` sites that
  existed when the rule was added. `tools/oxlint/await-in-loop.json` turns the
  rule off for those files. `pnpm await-in-loop:check` fails when a count goes
  up, and when a count goes down but its entry does not. Do not add entries.
  When you change a listed file, fix its sites and lower its entry.
