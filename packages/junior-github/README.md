# @sentry/junior-github

`@sentry/junior-github` adds GitHub deployment, issue, pull request, release,
repository, and user-attachment workflows to Junior using a GitHub App.

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

Pull requests created by the plugin are assigned to the current requester's
linked GitHub account. If there is no linked GitHub handle, the plugin leaves
the pull request unassigned. System actors do not receive assignments. A failed
identity lookup stops creation rather than silently skipping assignment.

The plugin saves the created pull request before it adds the assignee. If
assignment fails, the tool reports the failure. Retrying the same tool call
retries assignment on the saved pull request with the saved requester. It does
not create another pull request or replace existing assignees.

The plugin owns its signed webhook route, deployment, pull request, and release
events, and normalized pull request and issue outcome projections.
Those projections also feed native code-change records used by the dashboard
Code page and person profiles. Core only owns delivery from plugin-published
events into matching conversation subscriptions.
