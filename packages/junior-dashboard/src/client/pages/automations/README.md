# Automation editor

Core owns validation, creator access, revision checks, Schedule previews, and
the Event catalog. Preview requests cannot save or run work. Completed scheduled
Automations remain read-only.

The editor sends only changed fields. Keep unsupported triggers and stored
Destinations intact unless the user replaces them. Outcomes keep their order.
New messages can target only the current Destination or the creator.

Query refreshes must not replace an unsaved draft. After a stale save, the user
can keep their changed fields or load the latest saved version. Unchanged fields
come from that version; core checks its revision again on save.

The data router blocks navigation with unsaved changes. Browser unload uses the
native prompt. Save and Cancel keep the list query string.

Browser behavior lives in `e2e/automation-editor.spec.ts`. API and persistence
coverage lives in core's `tests/integration/api/automation-edits.test.ts`.
