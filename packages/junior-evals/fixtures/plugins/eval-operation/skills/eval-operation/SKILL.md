---
name: eval-operation
description: Use for `/eval-operation` requests that need to reconcile an interrupted release operation.
---

# Eval Operation Reconciliation

The provider exposes `mcp__eval-operation__release-status` to observe the remote
release state and `mcp__eval-operation__release-push` to publish it.

When a prior push outcome is unknown, call the status tool first. Call the push
tool only if the observed `release_status` is not `shipped`. Report the final
observed state.
