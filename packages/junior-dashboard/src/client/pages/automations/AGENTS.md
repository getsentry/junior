# Automation pages

## Boundaries

- Core owns validation, edit access, creator-only rules, revision checks,
  Schedule previews, and the Event catalog. The page shows core errors. It
  does not repeat these rules.
- Preview requests never save or run work.
- Completed scheduled Automations are read-only.

## Editor rules

- Send only changed fields. Keep unsupported triggers and stored
  Destinations unless the user replaces them. Keep outcome order.
- New messages can target only the current Destination or the creator.
- A public reader sees outcomes as read-only and cannot turn on creator
  credentials. Warn that an instruction or event selector change switches to
  system credentials.
- Pause, Resume, and Delete are creator-only. Hide them from other viewers.
- Query refreshes must not replace an unsaved draft. After a stale save, let
  the user keep their changes or load the latest version.
- Block navigation with unsaved changes.
- Lifecycle actions and "Make active" read the latest revision first.

## Page rules

- Each Automation has one page at `/automations/:id`. Keep the list query
  string on the way back. Drop tab-only params: `result`, `run`, `version`.
- `AutomationRecentRuns` shows terminal runs only. Do not infer queued or
  running work from terminal records.
- Delete keeps errors in the dialog and blocks dismissal while pending.

Browser journeys: `e2e/automation-editor.spec.ts` and
`e2e/automations.spec.ts`.
