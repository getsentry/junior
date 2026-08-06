---
title: Resource Subscriptions
description: Follow plugin resource events temporarily, or turn them into durable tasks.
type: conceptual
summary: Choose a temporary watch when you want updates, and an event task when you want automation.
prerequisites:
  - /concepts/skills-and-plugins/
related:
  - /concepts/tasks/
  - /extend/
---

Plugins can publish normalized resource events for things like issues, pull requests, deployments, or projects. Enabling a plugin does not create watches or automation by itself. Junior only creates what you ask for.

## Two paths

| Path | Use it for | Lifetime |
| ---- | ---------- | -------- |
| Resource subscription | watch, notify, tell-me-when | Temporary, thread-bound |
| Event task | whenever-this-happens-do-X | Durable, destination-bound |

A **resource subscription** delivers matching events back into the current conversation until it expires, completes, or is cancelled. It does not store a long-lived instruction.

An **event task** stores an instruction and runs it when a matching event arrives. It stays configured for that Slack channel or DM until deleted.

Both paths use the plugin's namespace, resource type, identifier, and supported events.

## Examples

```text
watch this pull request and tell me when its checks fail
```

That is a resource subscription.

```text
whenever an issue is reopened in this repository, summarize why in this channel
```

That is an event task.

## Rules worth knowing

- Watches default to 14 days and cannot be created for longer than 30 days.
- Stopping Junior in a thread cancels that conversation's active watches.
- Event payloads are bounded system input. They do not widen visibility or credential authority.
- Duplicate provider deliveries should not create duplicate conversation work.
- Resource events currently require single-workspace Slack mode.

## Plugin docs

Each plugin page should list:

- supported resource types
- identifiers or scopes it accepts
- supported events
- any webhook or provider setup required to publish those events

## Next step

Pick a plugin from [Plugins](/extend/), or read [Tasks](/concepts/tasks/) if you want durable automation instead of a temporary watch.
