# Automation pages

- Core owns validation, edit access, creator credential rules, revision checks,
  Schedule previews, and the Event catalog. Show core errors. Do not repeat
  these rules in the page.
- Preview requests never save or run work.
- Send only changed fields. Keep unsupported triggers and stored Destinations
  unless the user replaces them. Keep outcome order.
- Warn that an instruction or event selector change switches to system
  credentials.
- Query refreshes must not replace an unsaved draft. After a stale save, let
  the user keep their changes or load the latest version.
- Lifecycle actions and "Make active" read the latest revision first.
- `AutomationRecentRuns` shows terminal runs only. Do not infer queued or
  running work from terminal records.
