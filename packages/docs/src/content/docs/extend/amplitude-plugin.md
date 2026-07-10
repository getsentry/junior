---
title: Amplitude Plugin
description: Configure read-only Amplitude product analytics through Amplitude's hosted MCP server.
type: tutorial
summary: Connect Junior to Amplitude for read-only product analytics in Slack.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Amplitude plugin lets Slack users inspect product usage, active users, event segmentation, funnels, retention, saved charts and dashboards, experiments, cohorts, taxonomy, session replay, feature flags, guides and surveys, feedback, agent analytics, and user activity without granting Junior access to mutation tools.

Junior connects to Amplitude's hosted MCP server and starts Amplitude's OAuth flow when a user first requests analytics. The plugin exposes a fixed allowlist of Amplitude's documented search, retrieval, and query tools.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-amplitude
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-amplitude"]);
```

No Amplitude API key or secret key is required. Each user authorizes through Amplitude's hosted MCP OAuth flow, and Junior resumes the original conversation after authorization completes.

## Regional endpoint

The package defaults to Amplitude's US MCP endpoint:

```text
https://mcp.amplitude.com/mcp
```

For another Amplitude data region, set `AMPLITUDE_MCP_URL` to the regional MCP endpoint documented by Amplitude before starting Junior. The endpoint must use HTTPS.

## Read-only boundary

The plugin uses `allowed-tools` to expose only documented search, retrieval, list, and query operations. Rendering, creation, editing, updates, cohort sync triggers, taxonomy branch mutation, merge, and deletion tools never enter Junior's callable MCP catalog.

This allowlist is a client-side exposure boundary. Amplitude authorization remains the provider-side permission boundary. For defense in depth, grant connected users or service accounts `USE_MCP_READ` only and remove `USE_MCP_WRITE` from their project role. Amplitude's Member, Manager, and Admin roles include MCP write access by default until an administrator adjusts the role.

The plugin does not use Amplitude's progressive-discovery URL. Junior already loads provider catalogs on demand through `searchMcpTools`, while the standard endpoint supplies the complete catalog that Junior can filter before exposure.

### Allowed tools

The package exposes this exact provider tool surface:

```text
search
get_from_url
get_context
get_project_context
get_workspace_context
get_charts
get_dashboard
get_cohorts
get_experiments
get_users
get_flags
get_deployments
get_agent_results
get_events
get_properties
get_custom_or_labeled_events
get_transformations
get_group_types
get_session_replays
list_session_replays
get_session_replay_events
query_chart
query_charts
query_amplitude_data
query_experiment
get_cohort_sync_destinations
get_cohort_syncs
get_cohort_sync_history
get_branches
list_guides_surveys
get_guide_or_survey
get_feedback_insights
get_feedback_comments
get_feedback_mentions
get_feedback_sources
get_feedback_trends
query_agent_analytics_metrics
query_agent_analytics_sessions
query_agent_analytics_spans
get_agent_analytics_conversation
search_agent_analytics_conversations
get_agent_analytics_schema
```

Every other Amplitude MCP tool is unavailable through the plugin. When Amplitude adds another read operation, the package must explicitly add it before Junior can call it.

## What users can query

- DAU, WAU, MAU, and other active-user trends
- event totals, unique users, sessions, and property segmentation
- funnel conversion and step drop-off
- retention by cohort and interval
- saved chart and dashboard results
- experiment status and results
- cohorts, taxonomy, and event definitions
- session replay timelines and prior agent-analysis results
- feature flag definitions and tracking-plan branches
- guides, surveys, customer feedback, and agent analytics
- individual user activity when the connected account has access

Render, create, update, archive, delete, launch, stop, sync-trigger, and configuration operations are unavailable through this plugin. The skill also instructs Junior not to expose deployment API keys, credential fields, or unrelated raw feedback and conversation content returned by read tools.

## Verify

1. Ask Junior for an Amplitude metric, such as active users for the last seven days.
2. Complete the private Amplitude OAuth flow when Junior prompts for it.
3. Confirm the original conversation resumes with an analytics result.
4. Ask Junior to create or edit an Amplitude chart and confirm it explains that the plugin is read-only.

## Failure modes

- **Authorization required:** Retry the analytics request and complete the private OAuth flow.
- **Permission denied:** The connected Amplitude account cannot access the requested organization, project, or resource.
- **No matching tool:** The requested operation is not in the package's read-only tool allowlist.
- **Wrong region:** Set `AMPLITUDE_MCP_URL` to the correct regional MCP endpoint and restart the deployment.
- **Ambiguous project:** Name the Amplitude project or provide a chart, dashboard, experiment, cohort, or user identifier.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
