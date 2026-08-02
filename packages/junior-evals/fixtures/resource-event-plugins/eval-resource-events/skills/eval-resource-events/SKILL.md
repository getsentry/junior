---
name: eval-resource-events
description: Use for `$eval-resource-events` requests that create a watchable resource and monitor requested outcomes.
---

# Eval Resource Events

1. Call `searchMcpTools` for provider `eval-resource-events` and find the pull-request creation tool. Do not inspect other providers, installed plugins, or runtime configuration.
2. Call the returned `mcp__eval-resource-events__create-watchable-pull-request` tool with the requested title.
3. Continue the user's request from the returned pull-request result.
