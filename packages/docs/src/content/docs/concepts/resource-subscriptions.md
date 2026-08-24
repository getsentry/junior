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

- **Resource subscription** for “watch this” or “tell me when”. Use it when you want temporary, thread-bound updates in the current conversation.
- **Event task** for “whenever this happens, do this”. Use it when you want durable automation that stays attached to a Slack channel or DM.

An install can also create a temporary subscription after a successful provider action, or add short event guidance in `plugins.ts`. That install policy is separate from a user-authored watch or event task. See the [GitHub plugin](/extend/github-plugin/) for a concrete example.

## Examples

```text
watch this pull request and tell me when its checks fail
```

```text
whenever an issue is reopened in this repository, summarize why in this channel
```

```text
whenever a non-draft pull request opens in this repository, review it
```

Optional `match` facts come from the resource type. Junior drops events that do not match before it wakes the agent. Use a match field only when that resource type declares it. For GitHub, `isDraft`, `authorUsername`, and `authorEmail` work on `pull_request` and on `repository` watches that receive pull request events. Missing facts fail closed.

## Limits

- Watches default to 14 days and cannot exceed 30 days.
- Event data cannot change conversation visibility or credential access.
- App guidance cannot grant credentials, expand an instruction, or bypass action review.
- Duplicate provider deliveries should not create duplicate work.
- Resource events currently require single-workspace Slack mode.

Each plugin page lists its supported resources, events, and webhook setup.

## Next Step

Choose a provider from [Plugins](/extend/), or read [Tasks](/concepts/tasks/) for durable automation.
