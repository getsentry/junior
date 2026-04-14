---
title: Plugin Auth & Context
description: How Junior handles plugin auth, private OAuth prompts, and provider target context.
type: reference
prerequisites:
  - /reference/config-and-env/
related:
  - /extend/github-plugin/
  - /extend/sentry-plugin/
  - /operate/security-hardening/
---

Junior handles plugin authentication and provider context behind the scenes. Public plugin docs should focus on the workflows people actually run, not the internal command layer that powers them.

## What users do

Users work through normal requests about GitHub, Sentry, Notion, and other enabled plugins.

- Run the plugin workflow in Slack or the host chat surface.
- If Junior asks for authorization, follow the private prompt it sends.
- For Sentry, users can ask Junior to connect or reconnect their account proactively.
- If the target repository, org, or project is unclear, include it directly in the request.

## Auth behavior

Different plugins authenticate in different ways, but the visible pattern stays the same.

- GitHub uses host-managed GitHub App access configured by the operator.
- OAuth-based plugins such as Sentry send sign-in links privately to the requesting user.
- If a user token is stale or no longer has access, Junior prompts for re-authorization instead of asking users to manage tokens manually.
- GitHub capability and repo scoping are lightweight safety rails meant to reduce accidental writes and wrong-target mutations. They are not a hard boundary against an agent that is already allowed to request broader GitHub credentials.

## Context behavior

Junior works best when the request names the target clearly.

- For GitHub, include `owner/repo` when the repository is not obvious from the request or surrounding conversation.
- For Sentry, include the org and project when your workspace spans multiple targets.
- When follow-up requests stay on the same target, Junior can continue the workflow without restating every detail.

## Operator verification

After changing plugin env vars or auth settings, verify one real workflow end to end in the chat surface where users will run it. Confirm the request succeeds, the result is scoped to the expected target, and any auth prompt stays private to the requesting user.

## Next step

Set up a concrete integration with [GitHub Plugin](/extend/github-plugin/) or [Sentry Plugin](/extend/sentry-plugin/), then follow [Reliability Runbooks](/operate/reliability-runbooks/) when auth failures recur.
