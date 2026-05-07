# @sentry/junior-linear

`@sentry/junior-linear` adds Linear issue workflows to Junior through Linear's hosted MCP server.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-linear
```

Then register the plugin package in `juniorNitro(...)`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-linear"],
});
```

This package does not require a shared `LINEAR_API_KEY` or a custom OAuth app for the default setup. Each user connects their own Linear account the first time Junior calls a Linear MCP tool. Junior sends the authorization link privately and resumes the same Slack thread automatically after the user authorizes.

The package is designed for ticket-centric work: finding issues, creating issues, updating fields, adding comments, and moving work through the normal Linear workflow without leaving Slack.

Optional: set channel defaults when a Slack thread usually routes work to the same Linear destination:

```bash
jr-rpc config set linear.team Platform
jr-rpc config set linear.project "Cross-team reliability"
```

These defaults are only fallbacks. If the user names a different team or project in the request, Junior should follow the explicit request instead.

Full setup guide: https://junior.sentry.dev/extend/linear-plugin/
