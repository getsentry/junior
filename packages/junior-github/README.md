# @sentry/junior-github

`@sentry/junior-github` adds GitHub deployment, issue, pull request, release,
and repository workflows to Junior using a GitHub App.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-github
```

Add the plugin factory to the plugin set exported from `plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";

export const plugins = defineJuniorPlugins([
  githubPlugin({
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
]);
```

Full setup guide: https://junior.sentry.dev/extend/github-plugin/

The plugin owns its signed webhook route, deployment, pull request, and release
resource events, normalized pull request and issue outcome projections, and
dashboard operational report. Core only owns delivery from plugin-published
resource events into matching conversation subscriptions.
