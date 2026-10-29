---
title: Watches
description: Follow plugin events temporarily, or turn them into durable automations.
type: conceptual
summary: Choose a temporary watch for updates or an event automation for automation.
prerequisites:
  - /concepts/skills-and-plugins/
related:
  - /concepts/automations/
  - /extend/
---

Plugins can publish events for resources such as issues, pull requests, and deployments. Junior creates a watch or automation only when asked.

## Choose a Watch or Automation

- **Watch** for “watch this” or “tell me when”. Use it when you want temporary, thread-bound updates in the current conversation.
- **Event automation** for “whenever this happens, do this”. Use it when you want durable automation that stays attached to a Slack channel or DM.

An install can also create a temporary subscription after a successful provider action, or add short event guidance in `plugins.ts`. That install policy is separate from a user-authored watch or event automation. See the [GitHub plugin](/extend/github-plugin/) for a concrete example.

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

Optional `match` values come from the resource type. Junior drops events that do not match before it wakes the agent. Use a match key only when that resource type lists it. For GitHub, `isDraft`, `headBranch`, `openerUsername`, `openerEmail`, `openerRole`, and `authors` work on `pull_request` and on `repository` watches that receive pull request events. `headBranch` is the branch GitHub sent on the webhook. `openerUsername` is who opened the pull request. On a pull request that Junior opened, it is the GitHub account linked to the person who asked Junior to open it. Junior reads that link when the event arrives, so it also works after the person links GitHub later. People who only asked for updates do not change it. When Junior does not know that person's GitHub account, the event has no opener, and filters on it do not match. `openerRole` is the opener's role on the repository, such as `admin`, `maintain`, `write`, `read`, or `none` for most bots. For example, match `openerRole: ["read", "triage", "none"]` to skip pull requests from people who can push. `authors` is a list of the GitHub logins of the commit authors and `Co-authored-by` people, bots included. A match value matches when the list includes it, so match `authors: "octocat"` for pull requests that octocat wrote or co-wrote. Junior loads the opener role and the authors only when a filter uses them or an event matches, and the agent sees them in the event. Check suites with no pull request still publish to the repository, so you can watch builds on `main`. For Linear, `teamKey` works on `issue` and `team` watches that receive issue events. If a listed value is missing on the event, Junior does not match.

## Limits

- Watches default to 14 days and cannot exceed 30 days.
- Event data cannot change conversation visibility or credential access.
- App guidance cannot grant credentials, expand an instruction, or bypass action review.
- Duplicate provider deliveries should not create duplicate work.
- Events currently require single-workspace Slack mode.

Each plugin page lists its supported resources, events, and webhook setup.

## Next Step

Choose a provider from [Plugins](/extend/), or read [Automations](/concepts/automations/) for durable automation.
