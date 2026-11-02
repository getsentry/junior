# GitHub plugin

- Junior-owned issue, pull request, review, and push operations never fall
  back to user OAuth.
- Merge, fork, branch deletion, REST ref writes, and administration stay
  unsupported. Deny unknown REST writes and GraphQL mutations.
- Read tokens request read level only. Write tokens omit `permissions`, so
  GitHub applies the installation envelope.
- A failing repository hook must stop the commit or push.
- `junior_github_pull_request_requesters` stores only the core identity id
  and, for the opener, the Conversation. Do not copy logins or user data.
  Read the login through `ctx.users.readIdentity()` at webhook time.
- When the opener is unknown, leave the opener fields out. Never use the bot
  in its place.
- Webhooks never read the pull request body. Load values other than filter
  values only after an event matches.
- Hold no database connection during GitHub calls.
- Change `ready_to_merge_at` only after the Review item changes, so the next
  webhook retries a failure.
