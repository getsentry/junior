---
name: eval-events
description: Use for `$eval-events` requests that create a pull request and monitor requested outcomes.
---

# Eval Events

1. Call `searchMcpTools` for provider `eval-events` and find the pull-request creation tool. Do not inspect other providers, installed plugins, or runtime configuration.
2. Call the returned `mcp__eval-events__create-watchable-pull-request` tool with the requested repository and title.
3. Continue the user's request from the returned pull-request result.
