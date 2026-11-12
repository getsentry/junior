Slice C of item 7 in #2362. Saved event automations that still name an exact identifier move to the equal trigger with no identifier (`namespace + events + match`). A trigger never gets broader.

Refs #2362

## What changes

- **Contract.** `identifierMatch({ identifier, eventType })` is a new optional field in a plugin's `events` registration (`junior-plugin-api`). It returns the filters that select the same events of one type, or nothing. Each plugin owns its own identifier formats. Each converter rebuilds the identifier with the builder that its webhooks use, so a malformed identifier does not convert.
- **Core rule** (`event-automations/trigger-conversion.ts`). A trigger converts only when:
  - every selected event gets the same filters,
  - those filters agree with any saved filter on the same key,
  - the result passes the same catalog check as a new trigger (reach, `anyOf`, limits).

  Otherwise the trigger keeps its identifier. Rows whose event reach is `resource` therefore keep their identifiers.

- **New writes.** Create, update, and dashboard edits save the trigger with no identifier when it can convert.
- **Saved rows.** The heartbeat converts saved rows one at a time through `saveEventAutomation`. That save locks the row, checks its revision, and records a new automation version. A row that changed after it was read is left for the next tick. A row that cannot convert keeps its identifier and keeps running. No migration SQL.
- **Slack.** `message.posted` reach is now `{ anyOf: ["channelId"] }`. `requireSlackChannelMessageScope` always sets `channelId` to the destination channel. The ingest guard from #2407 still checks the destination channel.
- **Update tool.** When `match` is omitted, the update keeps the saved filters, so an update cannot drop filters by leaving them out. `{}` removes them.

## Per plugin

| Plugin | Converts                                                                                                                                     | Keeps identifier                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GitHub | repo, `repo#n` (issue or PR by event), release source (tag decoded), deployment source (environment decoded)                                 | identifiers that do not round-trip                                                                                       |
| Sentry | `org/project` and `org/project#issue` for `issue.created` (org dropped: one install is one org); `metric-alert:org/id` becomes `alertRuleId` | project identifiers on metric alert events, because a project list over the 4,000-byte event data limit drops `projects` |
| Vercel | `projectId[:target[:commitSha]]`                                                                                                             | identifiers that do not round-trip                                                                                       |
| Linear | team key becomes `teamKey`, `TEAM-123` becomes `issueIdentifier`                                                                             | —                                                                                                                        |
| Slack  | channel ID becomes `channelId`                                                                                                               | —                                                                                                                        |

Watches do not change. The identifier column stays until slice D.

## Checks

- `pnpm typecheck`, `pnpm lint`, prettier: pass
- GitHub, Sentry, Vercel, and Linear plugin suites: pass. Their webhook tests now use the real converters.
- Dashboard suite: pass
- Core integration: `any-resource-event-automations`, `slack/channel-message-automations`, and `api/automation-edits` pass. One test fails in `event-automations` ("delivers the current automation card…"). That test fails the same way on `main`.
