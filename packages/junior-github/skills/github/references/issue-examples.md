# Issue Examples

Calibrate structure and depth by comparing good and bad patterns.

## Bug example

Bad title: "Error in auth"
Good title: "OAuth token refresh fails during long-running operations"

Bad summary:

> Something is broken with auth tokens. Users are seeing errors.

Good summary:

> The SDK sets a dedup key before acquiring the per-thread lock. When the lock is contended, the message is permanently lost because the dedup slot is already consumed.

Bad structure — generic catch-all:

> ## Analysis
>
> - There's an auth error
> - It happens sometimes
> - We should fix it

Good structure — problem-specific sections:

> ## Root cause
>
> The dedup key is set _before_ the lock is attempted. When a second message arrives...
>
> ## Reproduction
>
> 1. Two users @-mention the bot in the same thread while processing
> 2. First message acquires the lock
> 3. Second message sets its dedup key, fails lock acquisition
>
> ## Expected behavior
>
> Either:
>
> - **Option A**: Acquire lock before setting dedup key
> - **Option B**: Clear dedup key on lock failure
>
> ## Workaround
>
> Retry wrapper that catches LockError and clears the dedup key (PR #32).
>
> Action taken on behalf of Jane Doe.

## Task example

Bad title: "Clean up some code"
Good title: "Remove 7 monkey-patches made unnecessary by SDK v2.1"

Bad scope:

> We have some patches we should clean up.

Good scope — quantified and specific:

> We maintain patches on **8 of 9 `process*` methods**. 7 exist solely to keep `waitUntil` offload behavior consistent while `processMessage` is customized for durable workflow routing. The 8th has two additional behavioral fixes.
>
> | Method            | Patch reason                                      |
> | ----------------- | ------------------------------------------------- |
> | `processReaction` | scheduling only                                   |
> | `processAction`   | scheduling only                                   |
> | `processMessage`  | scheduling + thread ID normalization + lock retry |
>
> Action taken on behalf of Jane Doe.

## Feature example

Bad framing:

> It would be nice to have better config reloading.

Good framing — current state, gap, options:

> ## Current behavior
>
> Workers read config at startup. Changes require a full restart.
>
> ## Gap
>
> Config changes during incidents require redeploying, adding 2-3 minutes to mitigation.
>
> ## Options
>
> | Approach                    | Tradeoff                           |
> | --------------------------- | ---------------------------------- |
> | File watch + hot reload     | Simple, but no atomicity guarantee |
> | Config service with polling | Consistent, but adds a dependency  |
>
> Action taken on behalf of Jane Doe.

## Principles

- Use problem-specific headings, not generic labels
- Include code snippets when they clarify the pattern
- Quantify scope precisely ("8 of 9", not "many")
- Cross-reference related issues and PRs
- Show concrete options with tradeoffs, not vague "should be fixed"
- Use tables for structured comparisons

## Anti-patterns

- Over-structured issues: using ## Summary, ## Impact, ## Root Cause headings for a 3-line bug
- Adding "Expected behavior" or "Desired outcome" when the thread didn't state one
- Restating the title as the first sentence of the body
- Confident fix claims without root-cause evidence
- Speculative detail mixed into verified facts
- Dumping a list of URLs without inline context
- Session-specific content (user names, slash commands, channel references)
- Missing delegated attribution footer on user-requested issue creation
