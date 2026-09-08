# @sentry/junior-linear

`@sentry/junior-linear` lets Junior read and update Linear through its GraphQL API. It also supports issue webhooks.

Install it alongside `@sentry/junior`, then register `linearPlugin()` in `plugins.ts`.

## OAuth app

Create a Linear OAuth app with:

- Callback: `https://<junior-host>/api/oauth/callback/linear`
- Scopes: `read,write`
- Environment variables: `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`

Junior requests `actor=app`. A workspace admin installs the app once. Junior then uses that app connection for requests from conversations, scheduled tasks, and event tasks. It does not ask each user to connect Linear.

Linear records changes as made by the Junior app. The app can access every team available to it in the connected workspace. If Linear rejects the refresh token, an admin must install the app again.

The tools can read and search issues, create and update issues, add comments, and list teams, projects, and workflow states. Junior links created issues to the current conversation.

## Webhooks

To run watches or event tasks when Linear issues are created:

1. Set `LINEAR_WEBHOOK_SECRET`.
2. Create a Linear webhook for the `Issue` resource at `https://<junior-host>/api/webhooks/linear`.
3. Redeploy Junior.

The plugin verifies `Linear-Signature` and publishes `issue.created` for the issue identifier and team key.

You can set conversation defaults with `linear.team` and `linear.project`. An explicit team or project in the request always wins.
