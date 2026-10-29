# Automation editor

Core owns validation, edit access, creator-only rules, revision checks,
Schedule previews, and the Event catalog. Preview requests cannot save or run
work. Completed scheduled Automations remain read-only.

Owners and public Destination readers can edit. For a public reader, the
editor shows outcomes as read-only and blocks turning on creator credential
use. It warns that an instruction or event selector change switches to system
credentials. Pause and resume stay creator-only.

The editor sends only changed fields. Keep unsupported triggers and stored
Destinations intact unless the user replaces them. Outcomes keep their order.
New messages can target only the current Destination or the creator.

Query refreshes must not replace an unsaved draft. After a stale save, the user
can keep their changed fields or load the latest saved version. Unchanged fields
come from that version; core checks its revision again on save.

The data router blocks navigation with unsaved changes. Browser unload uses the
native prompt. Save and Cancel keep the list query string.

Version history lists saved versions, newest first, and marks the active
version. "Make active" uses the native confirm dialog, like delete. It then
reads the latest revision and asks core to save that version again as a new
version. Core applies the same edit rules, so the page
shows its error when a public reader cannot make a version active.

Browser behavior lives in `e2e/automation-editor.spec.ts`. API and persistence
coverage lives in core's `tests/integration/api/automation-edits.test.ts`.

## Automation details

The URL selects one Automation in the list. `AutomationDetails` uses the shared
`DetailsPanel`: a 400px panel at 1280px and above, and a Base UI bottom sheet on
smaller screens. The list stays interactive beside the panel. Each pane scrolls
on its own. `VisualViewportShell` owns the viewport height and mobile body lock;
`AutomationsPageLayout` keeps navigation above the list and details.

Loading and access errors stay inside the details frame. Closing keeps the list
query string and returns focus to the selected row. If that row is not on the
current page, focus returns to the list. Selecting another Automation resets
its disclosures and lifecycle feedback. Deleting the selected Automation closes
its details. Edit and version history retain the list query string.

The existing Automation browser journeys cover selection, loading and retry,
focus, mobile dismissal, deletion, and lifecycle actions. Use mock reporting to
review scheduled and event Automations in both themes at desktop and mobile
widths. Keep layout and scrollbar checks in manual QA.
