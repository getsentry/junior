---
title: PagerDuty Plugin
description: Configure read-only PagerDuty lookups for on-call, handoffs, schedules, escalation policies, services, and incidents.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The PagerDuty plugin lets Slack users ask Junior who is on call, who rotates in or out next, and what is open in PagerDuty. Junior calls the PagerDuty REST API from the sandbox.

The plugin is read-only. It uses one deployment-level API key, and the bundled skill uses only `GET` requests.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-pagerduty
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-pagerduty"]);
```

## Config

Set deployment variables in the Junior environment, then redeploy.

### Environment variables

<details class="plugin-config">
<summary><code>PAGERDUTY_API_KEY</code></summary>

PagerDuty REST API key for read-only requests.

- **Define:** Set `PAGERDUTY_API_KEY` in the deployment environment
- **Required:** Yes
- **Environment override:** `PAGERDUTY_API_KEY`

Use an account-level General Access REST API key with **Read-only API Key** enabled. An admin or account owner creates it in **Integrations > Developer Tools > API Access Keys**.

</details>

## Auth model

- The plugin uses one deployment-level PagerDuty API key, not per-user OAuth.
- Junior keeps the real `PAGERDUTY_API_KEY` value on the host.
- Sandbox requests to `api.pagerduty.com` receive a host-managed `Authorization: Token token=<key>` header.
- The sandbox never receives the key in env, files, or command arguments.
- Users do not connect or disconnect individual PagerDuty accounts from Junior App Home for this plugin.

## What users can do

- Ask who is on call now for a schedule, escalation policy, or service.
- Ask who rotates in or out next and when the handoff happens.
- Inspect schedule members, escalation paths, and team members.
- List open incidents and read incident details, timelines, and notes.

## Verify

1. Set `PAGERDUTY_API_KEY` and redeploy.
2. Ask Junior in a channel: `Who is on call for <schedule name> right now, and who is next?`
3. Confirm the reply names the current and next responders, the handoff time, and a PagerDuty link.

## Failure modes

- `PAGERDUTY_API_KEY` missing: Junior cannot add the credential. Set the env var and redeploy.
- `401 Unauthorized`: the key is invalid or revoked.
- `403 Forbidden`: the key cannot read the requested resource.
- `429 Too Many Requests`: PagerDuty is throttling. Retry later or narrow the request.
- EU-region account: the manifest covers only `api.pagerduty.com`. EU accounts need a manifest change for `api.eu.pagerduty.com`.
- Mutation requests (acknowledge, resolve, override): the plugin is read-only, and the skill declines these.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
