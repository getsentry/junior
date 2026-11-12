**Not a breaking change.** Users, plugins, saved automations, and the dashboard API see the same behavior as before. This PR changes how core decides two existing rules, and it adds docs.

## What this changes

Core has its own event resource types: Workspace snapshots, timers, and Slack channel messages. Two rules apply to them:

- Event automations cannot use Workspace snapshot or timer events.
- `watchEvents` cannot watch timers (use `watchTimer`) or Slack channel messages (use an event automation).

Before, core hard-coded these rules as checks on the namespace strings `"junior"`, `"timer"`, and `"slack"`. Now each core registration declares its rules in a `limits` map, keyed by resource type (`EventResourceTypeLimits` in `chat/events/catalog.ts`):

- `automation: false` for `workspace_snapshot` and `timer`.
- `watch: false` for `timer` and Slack `channel`. Each one also sets `watchUnavailableMessage`, which tells the agent what to use instead. The messages are the same as before.

The limits sit beside the resource types, not on them. So the resource type objects stay plain plugin-api `PluginEventType` values.

## Why it is not breaking

- **Plugin API:** no change. `limits` is on a core-only registration type. `@sentry/junior-plugin-api` does not change, and plugins cannot set limits.
- **Same results:** the new checks accept and reject the same inputs as the old ones. All `junior` resource types set `automation: false`, so that namespace is still left out of automations. `slack` has only `channel`, so the watch rejection covers the same inputs.
- **Saved automations:** availability does not change. Every place that checks it reads the same filtered catalog.
- **Dashboard API:** `/event-catalog` returns the same shape. It builds each entry from the plugin-api resource type only, so it does not need to remove core fields. A new core limit cannot break the strict response schema.
- **Public exports:** none of the changed code is exported from `@sentry/junior`.

## Docs

- **`deployment.*` events:** the GitHub and Vercel READMEs and the public plugin pages now say what each event means. Vercel `deployment.error` is the same as GitHub `deployment.failed`, not GitHub `deployment.error`.
- **`chat/events/README.md`:** now covers `eventKey`, `occurredAtMs`, `objectType`, the reserved `junior` and `slack` namespaces, the `limits` map, and short steps to add an event type.

Part of #2362, item 5. An earlier commit added regex identifier patterns for Linear and Sentry, and a later commit removes them. #2362 item 6 is replacing regex patterns with structured identifier parts.

## Merge order with #2381

#2381 deletes `pluginSupportsEvent`, and this PR still uses it. Whichever PR merges second must rebase onto the other and resolve that conflict.

## Checks

- `pnpm typecheck` and `pnpm lint` pass.
- The event catalog, watch, search, snapshot, Slack channel automation, heartbeat timer, Workspace tool, and automation edit tests pass. The automation edit test covers `/api/automations/event-catalog`.
- One test, "delivers the current automation card and retains its reference in web history" in `event-automations.test.ts`, also fails on `main` without this change.
