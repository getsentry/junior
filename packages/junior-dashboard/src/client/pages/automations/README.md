# Automation editor

The list supports scanning. The drawer supports quick inspection. The editor
at `/automations/:kind/:automationId/edit` owns a single unsaved draft.

Core owns save validation, creator checks, revision checks, Schedule compilation,
and the enabled Event catalog. The dashboard does not copy provider rules or
calculate future occurrences. Preview requests cannot save or dispatch work.
Completed scheduled Automations are read-only, as required by core.

The editor sends only changed fields. A metadata edit must not reset a Schedule,
replace an unsupported Event trigger, or discard ordered outcomes. Keep unknown
stored Destinations intact. New outcomes use only the current Destination or the
creator. Do not infer a private recipient from a channel id.

A stale save keeps the draft. The user must inspect the latest saved values and
choose whether to keep their changed fields. Unchanged fields come from the
latest version. A second concurrent write still fails at the core revision check.

The data router supports navigation blocking. Browser unload uses the native
unsaved-change prompt. API refreshes do not seed the form again. Save and Cancel
retain the list query string. Saving never runs work.

Use shared Field, TextInput, TextArea, Select, Button, and FormNotice components.
Keep one aligned field column, section borders, and a sticky action bar. On narrow
screens, place section headings above controls. Ordered message controls must not
hide the Destination. Native date and time fields stay at a readable mobile size.

Browser journeys in `e2e/automation-editor.spec.ts` own draft, save, navigation,
and recovery contracts. Core integration coverage in
`tests/integration/api/automation-edits.test.ts` owns API authority and persistence.
Use manual screenshots for visual review, not geometry assertions.
