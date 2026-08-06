---
title: Resource Subscriptions
description: Follow plugin resource events temporarily, or turn them into durable tasks.
type: conceptual
summary: Choose a temporary watch for updates or an event task for automation.
prerequisites:
  - /concepts/skills-and-plugins/
related:
  - /concepts/tasks/
  - /extend/
---

Plugins can publish events for resources such as issues, pull requests, and deployments. Junior creates a watch or task only when asked.

## Choose a Watch or Task

| Type | Use it for | Lifetime |
| ---- | ---------- | -------- |
| Resource subscription | “Watch this” or “tell me when” | Temporary and thread-bound |
| Event task | “Whenever this happens, do this” | Durable and destination-bound |

A resource subscription sends matching updates to the current conversation. It ends when it expires, completes, is cancelled, or Junior leaves the thread.

An event task stores an instruction and runs it for each matching event. It remains attached to its Slack channel or DM until deleted.

## Examples

```text
watch this pull request and tell me when its checks fail
```

```text
whenever an issue is reopened in this repository, summarize why in this channel
```

## Limits

- Watches default to 14 days and cannot exceed 30 days.
- Event data cannot change conversation visibility or credential access.
- Duplicate provider deliveries should not create duplicate work.
- Resource events currently require single-workspace Slack mode.

Each plugin page lists its supported resources, events, and webhook setup.

## Next Step

Choose a provider from [Plugins](/extend/), or read [Tasks](/concepts/tasks/) for durable automation.
