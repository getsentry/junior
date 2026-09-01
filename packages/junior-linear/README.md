# @sentry/junior-linear

`@sentry/junior-linear` adds native Linear GraphQL tools and issue webhooks to Junior.

Install it alongside `@sentry/junior`, then register `linearPlugin()` in `plugins.ts`.

## OAuth app

Create a Linear OAuth application and configure:

- Callback: `https://<junior-host>/api/oauth/callback/linear`
- Scopes: `read,write`
- Environment: `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`

Junior sends `actor=app`. A workspace admin authorizes the app once. Junior stores the access and refresh tokens for the installation, refreshes them behind a provider lock, and uses the app credential for interactive, scheduled, and event work.

The initial policy is a hard cutover from MCP: mutations use Junior app attribution, per-user OAuth is not retained, and the Linear workspace is the access boundary. There is no separate team allowlist in this version. A rejected refresh token is removed and requires an admin reinstall.

The native tools cover issue get/search/create/update, comment creation, and team, project, and workflow-state lookup. Created issues are linked to the current Junior conversation.

## Webhooks

To run watches or event tasks when Linear issues are created:

1. Set `LINEAR_WEBHOOK_SECRET`.
2. Create a Linear webhook for the `Issue` resource at `https://<junior-host>/api/webhooks/linear`.
3. Redeploy Junior.

The plugin verifies `Linear-Signature` and publishes `issue.created` for the issue identifier and team key.

Optional conversation defaults remain available through `linear.team` and `linear.project`. Explicit user input wins over these defaults.
