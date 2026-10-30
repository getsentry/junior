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
native prompt. Save and Cancel return to the Automation page and keep its query
string.

Version history lists saved versions, newest first, and marks the active
version. "Make active" uses the native confirm dialog, like delete. It then
reads the latest revision and asks core to save that version again as a new
version. Core applies the same edit rules, so the page
shows its error when a public reader cannot make a version active.

Browser behavior lives in `e2e/automation-editor.spec.ts`. API and persistence
coverage lives in core's `tests/integration/api/automation-edits.test.ts`.

## Automation page

Each Automation has one page at `/automations/:id`. Overview, Runs, and
Versions are tabs. They use `SecondaryNavigation`, like the repository page.
`/automations/:id/edit` is edit mode of the Overview tab. The old
`/executions` route redirects to `/runs` and keeps the query string. List rows
link to the page. There is no details slideout.

The page keeps the list query string. "All automations" returns to the same
list page and filters. The back link drops params that belong to one tab:
`result`, `run`, and `version`. One `range` param drives the Overview numbers
and the Runs chart.

The header shows the name, the state, the trigger, the Destination, and the
creator. `AutomationStateChip` is a live region, so Pause and Resume results
are announced. `AutomationActions` owns Edit, Pause or Resume, pause help, and
Delete. Lifecycle actions re-read the revision before they apply. Public
readers can edit settings. Pause, Resume, and Delete stay creator-only, so
other viewers do not see them. The About card names the creator-only actions.
Completed Automations have no Edit action, and `/edit` returns to Overview.

Overview shows `AutomationAttention` first when something needs action: a
block, an unavailable trigger, or a failed last run. The notice has one main
action, such as Change trigger or Open last run. While it shows, the header
Edit button becomes a secondary button. The saved settings follow
in the same `AutomationFormSection` rows as the editor, so edit mode changes
them in place. The side column shows the next trigger, the last result, runs,
failures, and spend for the range, and About. Spend is `costUsd` from the
Automation summary. On small screens, status comes first and About moves below
the settings.

`AutomationRecentRuns` uses the existing execution-history query and cache. It
shows up to three newest terminal runs, links to their Conversations when one
was recorded, and displays recorded runtime and estimated cost. It omits run
titles that repeat the Automation name. Its loading,
empty, and retry states do not replace Automation settings. It does not infer
queued or running work from terminal records.

In edit mode, "Your changes" lists each changed field with the saved value, the
new value, and its own Undo. It is beside the form on wide screens and below
the form on small screens when there are changes. Undo remounts the fields, so fields with local state show the saved value again.
Changed sections get an accent mark. Save and Cancel return to Overview.

The Runs tab filters loaded runs by result through the `result` param. Rows
show the version that ran and the recorded error. A row opens the run details
panel. The run list scrolls on its own beside it.

The Versions tab lists versions and compares the selected one with the version
before it. The `version` param selects a version; run details link to it.
Changed fields show the previous value. Instruction changes use a line diff.

`AutomationDeleteDialog` names the Automation before deletion. It keeps errors
and retry inside the dialog and blocks dismissal while the request is pending.
Cancel returns focus to Delete. Successful deletion returns to the list.
Success toasts confirm Save, Pause, Resume, and Delete. Their state belongs to
the mounted dashboard's Toaster provider.

Browser journeys for the page live in `e2e/automations.spec.ts`. Use mock
reporting to review scheduled and event Automations in both themes at desktop
and mobile widths. Keep layout checks in manual QA.

Filters use a shadcn Popover at 768px and above and the shared BottomSheet below
that width. Both edit the same URL filters immediately. Active filter chips
remove one filter without clearing search, scope, or other filters. The mobile
sheet fits its controls instead of taking the full screen height.
