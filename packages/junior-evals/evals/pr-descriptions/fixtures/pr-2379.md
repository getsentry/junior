Part of #2362, item 5 (core and docs). The unsupported-event error is not in this PR. The filter-rules PR owns it.

**Core resource type limits**

Core checked namespace strings to decide what watches and event automations can use:

- `automationEventCatalog` removed the whole `junior` namespace.
- `watchEvents` rejected `junior` + `timer`, and every `slack` resource type.

Now the resource types carry the limits. Two fields are added to a new core-only type, `EventCatalogResourceType` in `chat/events/catalog.ts`:

- `automation: false`: event automations cannot use the resource type. `workspace_snapshot` and `timer` set it.
- `watchUnavailable`: `watchEvents` rejects the resource type with this message. `timer` and Slack `channel` set it. The messages are the same as before.

The published `@sentry/junior-plugin-api` does not change. `pluginEventTypeSchema` is strict, so plugins cannot set these fields. The dashboard event catalog route removes them before it returns the response, because its schema is strict too.

`automationEventCatalog` now filters by resource type and drops a namespace that has no resource types left. Behavior stays the same:

- Every `junior` resource type sets `automation: false`, so the namespace is still removed.
- `slack` has only `channel`, so the watch rejection covers the same inputs.
- `eventAutomationTriggerAvailable` and the SQL availability filter in `automations/collection.ts` read the same filtered catalog. A saved automation still has the same availability.

**Identifier patterns**

| Resource type    | Format                | Pattern                     |
| ---------------- | --------------------- | --------------------------- |
| Linear `issue`   | `TEAM-123`            | `^[A-Z][A-Z0-9]*-\d+$`      |
| Linear `team`    | `TEAM`                | `^[A-Z][A-Z0-9]*$`          |
| Sentry `issue`   | `org/project#issueId` | `^[^\s/#:]+\/[^\s/#]+#\d+$` |
| Sentry `project` | `org/project`         | `^[^\s/#:]+\/[^\s/#]+$`     |

- Core checks each pattern after `normalizeIdentifier`, so Linear values are uppercase and Sentry values are lowercase.
- The Linear patterns use the same key shape as the Linear plugin's issue identifier check.
- The Sentry project pattern does not accept `:`. So a `metric-alert:org/123` identifier does not fit `project`, and the error suggests `metric_alert`.
- The webhook tests now check that each normalized identifier fits its resource type.

**Docs**

- GitHub and Vercel READMEs, plus the public plugin pages: what each `deployment.*` event means. Vercel `deployment.error` is the same as GitHub `deployment.failed`, not GitHub `deployment.error`.
- `chat/events/README.md`:
  - `eventKey`, `occurredAtMs`, and `objectType`.
  - Both reserved namespaces, `junior` and `slack`.
  - The new limits.
  - Short steps to add an event type.

**Checks**

- `pnpm typecheck`: pass.
- `pnpm lint`: pass.
- `@sentry/junior-sentry` and `@sentry/junior-linear` tests: pass.
- `@sentry/junior` tests for the catalog, watch, search, snapshot, Slack channel automation, automation edit, event automation, and timer paths: 155 pass, 1 fail. The failure is "delivers the current automation card and retains its reference in web history" in `tests/integration/event-automations.test.ts`. It also fails on `main` without this change, as #2373 reported.

**Open questions**

- Sentry `issue` now needs a numeric issue id. A short ID such as `JUNIOR-1A` is rejected and the error shows the format. Before, it was accepted but never matched an event, because webhooks use the numeric id.
- The GitHub `failure` vs `error` text follows GitHub's state names. The deploy tool sets the state, so the docs say the difference depends on that tool.
