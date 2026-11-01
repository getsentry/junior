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
identity id of that person. The opener row also has the Conversation where
they asked. The plugin does not copy the user or GitHub login.
When a webhook needs the GitHub login, it reads the identity through
`ctx.users.readIdentity()` and uses the GitHub identity of the linked user. So a
person who links GitHub later is found on their older pull requests too. The
create tool saves the opener after GitHub opens the pull request. The first row
for a pull request is the opener. Later updates never replace it. When the
create has no Junior identity, the first person who asks Junior to update the
pull request is the opener. A retry of the same tool call saves the opener
again, in case the first call stopped before it did.

Pull request events have two kinds of people fields. `openerUsername`,
`openerEmail`, and `openerRole` name who opened the pull request. On a pull
request that Junior's bot opened, the opener is the person who asked Junior to
open it: the linked GitHub login of the saved opener row. With no saved row, no
linked GitHub login, or a failed identity lookup, the opener is unknown and the
event has no opener fields, so filters on them do not match. The bot is never
used in its place. An `opened` event can arrive before the create tool saves
the row. `authors` lists the GitHub logins of the commit authors and of the
`Co-authored-by` trailers with GitHub noreply emails, bots included. Webhooks
never read the pull request body.

The opener on Junior's pull requests, `openerRole`, and `authors` need database
or GitHub calls. A webhook loads the values that a Watch or event automation
filters on before it decides on a match. It loads the other values only when an
event matches, so the agent sees all of them. A failed load leaves the value
out. `authors` and the people involved in approvals and merges share one read of
the commits per delivery.

When a Junior pull request is ready to merge, the plugin adds a notice to the
review desk through `ctx.reviewItems`. Ready to merge means that the pull
request is open, is not a draft, has an approval and no open change request,
and GitHub's `mergeable_state` is `clean`. `clean` covers required reviews,
checks, commit statuses, and conflicts. `pull_request`, `pull_request_review`,
and `check_suite` webhooks make the plugin read these facts again from GitHub.
GitHub computes `mergeable_state` after a change. When it is still unknown
after a second read, the plugin changes nothing, and a later webhook decides.
The notice goes to the opener, in the Conversation where they asked. It tells
them to merge the pull request, or to say why not. `ready_to_merge_at` on the
pull request records that the notice was added, so repeat webhooks add no
second notice. One webhook at a time checks a pull request. A webhook that
arrives during a check adds 1 to `ready_sync_requests` and stops. The webhook
that runs the check then reads GitHub again, until no new request came in.
`ready_sync_id` names that check, and a check older than one minute no longer
blocks others. No database connection stays open during the GitHub calls.
`ready_to_merge_at` changes only after the notice changes, so after a failure
the next webhook tries again. A notice that a person closed does not come back
until the pull request is ready again. The plugin closes the notice when the
pull request merges, closes, or is no longer ready. "Changes requested" adds
no notice. A notice failure is logged and does not fail the webhook.

Deployment events come from GitHub `deployment` and `deployment_status`
webhooks:

| Event                    | GitHub source               |
| ------------------------ | --------------------------- |
| `deployment.created`     | `deployment` with `created` |
| `deployment.queued`      | status `queued`             |
| `deployment.pending`     | status `pending`            |
| `deployment.in_progress` | status `in_progress`        |
| `deployment.succeeded`   | status `success`            |
| `deployment.failed`      | status `failure`            |
| `deployment.error`       | status `error`              |

GitHub has two failure states. `failure` means that the deployment ran and
failed. `error` means that the deploy tool reported an error. The deploy tool
sets the status, so the difference depends on that tool. Vercel
`deployment.error` is a failed deployment, so it is the same as GitHub
`deployment.failed`, not GitHub `deployment.error`. `succeeded`, `failed`, and
`error` end a watch on one commit and environment. Watches on a commit or a
repository stay active.

The plugin owns its signed webhook route, deployment, pull request, and release
events, and normalized pull request and issue outcome projections.
Those projections also feed native code-change records used by the dashboard
Code page and person profiles. Core only owns delivery from plugin-published
events into matching conversation subscriptions.
