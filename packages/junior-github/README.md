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

The plugin tries to assign new pull requests to the current requester's linked
GitHub account. Assignment is optional. Missing handles, system actors, identity
lookup errors, and assignment failures do not stop creation or fail the tool.
If assignment is not possible, the pull request can remain unassigned.

The plugin saves the created pull request before it tries assignment. Retrying
the same tool call returns the saved pull request without retrying assignment,
creating another pull request, or replacing existing assignees.

The plugin saves each person who asks Junior to open or update a pull request in
`junior_github_pull_request_requesters`. Each row has only the core Junior
identity id of that person. The plugin does not copy the user or GitHub login.
When a webhook needs the GitHub login, it reads the identity through
`ctx.users.readIdentity()` and uses the GitHub identity of the linked user. So a
person who links GitHub later is found on their older pull requests too. The
first row for a pull request is the opener. Later updates never replace it. When
the create has no Junior identity, the first person who asks Junior to update
the pull request is the opener. The create tool writes a pending row with no
number before it calls GitHub, because the `opened` webhook can arrive first.
GitHub has not given a number yet, so the pending row names the head branch.
Each pending row belongs to one Junior identity. After GitHub opens the pull
request, the tool replaces its own pending row with a row that has the number.
A create that GitHub rejects removes only its own pending row. Only `opened`
events for a head in the same repository read pending rows. They use one only
when the pull request has no row and the branch has exactly one pending row
from the last 10 minutes. Concurrent creates on one branch give
no opener until the create tool saves the row. Fork heads (`owner:branch` in
another repository) get no pending row. Webhooks use the opener's GitHub login
for `requesterUsername` and `requesterRole`. If the identity lookup fails, the
event has no requester fields, so filters on them do not match. Webhooks never
read the pull request body.

The plugin owns its signed webhook route, deployment, pull request, and release
events, and normalized pull request and issue outcome projections.
Those projections also feed native code-change records used by the dashboard
Code page and person profiles. Core only owns delivery from plugin-published
events into matching conversation subscriptions.
