# GitHub plugin

## Intent

- The plugin owns all GitHub behavior: credentials, egress policy, tools,
  signed webhooks, events, and pull request and issue outcomes.
- Core owns only delivery of published events to matching subscriptions.
  Do not add GitHub routes, fields, or decisions to core.

## Credentials and egress

- The plugin picks the grant from the forwarded request:
  `installation-read` for reads, `user-read` for `GET /user`,
  `installation-write` for allowlisted App writes and Git smart-HTTP pushes,
  and `user-write` for user-attachment uploads.
- Deny unknown REST writes and GraphQL mutations. Merge, fork, branch
  deletion, REST ref writes, and administration stay unsupported.
- Junior-owned issue, pull request, review, and push operations never fall
  back to user OAuth.
- The sandbox never gets a raw token. The host adds the `Authorization`
  header.
- Read tokens request read level only. Write tokens omit `permissions`, so
  GitHub applies the installation envelope.

## Commits

- Junior is author and committer. Credit human actors once with
  `Co-Authored-By` trailers.
- Junior sets `core.hooksPath` in the command env for every sandbox command.
  Its hooks pass all other client hooks to the repository hooks. A failing
  repository hook must stop the commit or push.

## Pull requests

- Save the created pull request before assignment. Assignment failures never
  fail the tool. A retry returns the saved pull request and does not create
  or reassign.
- `junior_github_pull_request_requesters` stores only the core identity id
  and, for the opener, the Conversation. Do not copy logins or user data.
  The first row is the opener. Later rows never replace it.
- Read the GitHub login through `ctx.users.readIdentity()` at webhook time.
- When the opener is unknown, leave the opener fields out. Never use the bot
  in its place.
- Webhooks never read the pull request body.
- Load only filter values before the match. Load other values only after an
  event matches. A failed load leaves the value out.

## Ready-to-merge notice

- Ready means open, not draft, approved, no open change request, and
  `mergeable_state` is `clean`.
- One webhook at a time checks a pull request (`ready_sync_id`,
  `ready_sync_requests`). Hold no database connection during GitHub calls.
- Change `ready_to_merge_at` only after the review item changes, so the next
  webhook retries a failure. A notice failure must not fail the webhook.
- Close the notice when the pull request merges, closes, or stops being ready.
