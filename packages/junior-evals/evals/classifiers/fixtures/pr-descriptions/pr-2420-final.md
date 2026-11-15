Fixes two flaky behavioral evals. Refs #2413.

**Deployment watch eval** (`evals/coding/subscriptions.eval.ts`)

The test required the agent to look up the deployment before it set up the watch. In this test the deployment does not exist yet, so the lookup does nothing and the order does not matter. I removed that check. The test still checks that the agent sets up the right watch.

**Delegation eval** (`evals/agent/delegation.eval.ts`)

The child agents read the live PostgreSQL, MySQL and SQLite docs sites. That made the test slow, and it often ran past the 60 s time limit. Now the test serves a saved copy of one real docs page for each database, so the reads are fast.

The test still checks the same thing: the agent splits the research into child agents. If the agent does not split the work, the test fails. That is a real failure, not flakiness.
