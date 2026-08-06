---
title: Resource Subscriptions
description: Follow plugin resource events with temporary updates or durable instructions.
type: conceptual
summary: Understand the two core tool paths available for plugin resource events.
prerequisites:
  - /concepts/skills-and-plugins/
related:
  - /concepts/tasks/
  - /extend/
---

Plugins can publish normalized resource events for provider resources such as
issues, pull requests, deployments, or projects. Each plugin page lists the
resource types and events that plugin supports.

Junior gives the agent two tool paths for those events:

- **Resource subscription** — for watch, notify, or tell-me-when requests. A
  temporary conversation association that delivers matching events back to the
  current conversation until it expires, completes, or is cancelled. It does not
  run a stored durable instruction.
- **Event task** — for whenever-this-happens-do-X automation. A durable
  instruction that Junior dispatches when a matching resource event occurs, then
  delivers to its Slack channel or DM. Event tasks remain configured for that
  destination until deleted, not only the thread where they were created.

Both paths use the plugin's registered namespace, resource type, identifier, and
supported events. Enabling a plugin or configuring its webhook does not create
either one; the agent creates the requested resource subscription or event task
through a core tool.

## Examples

```text
watch this pull request and tell me when its checks fail
```

This asks for a resource subscription because it follows one resource for a
limited time in the current conversation.

```text
whenever an issue is reopened in this repository, summarize why in this channel
```

This asks for an event task because it stores an ongoing instruction for future
matching events.

## Plugin documentation

A plugin page should list every supported resource type, the identifier or scope
it accepts, and every supported event. It should also explain the provider setup
needed to publish events, such as webhook configuration.

## Next step

Choose a plugin from [Plugins](/extend/) and use its resource subscriptions
section to see what the agent can watch or automate.
