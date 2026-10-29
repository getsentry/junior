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

The URL selects one Automation in the list. Route matching follows React
Router, including trailing slashes. `AutomationDetails` uses the shared
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

Details lead with lifecycle, the next trigger, and the last execution result.
Instructions follow, then compact trigger and delivery rows. The sheet header
uses the Automation name. `AutomationStatus`
keeps a failed execution distinct from whether future runs remain enabled. It
shows block reasons and links to the last Conversation when attention is needed.
Scheduled times use the shared shadcn Accordion to show the schedule timezone
and browser time. About this Automation uses the same component. Both start
collapsed and reset when the selection changes.
Paused, blocked, completed, and unavailable Automations explain why there is no
next run instead of showing "None".

`AutomationRecentRuns` uses the existing execution-history query and cache. It
shows up to three newest terminal runs, links to their Conversations when one
was recorded, and displays recorded runtime and estimated cost. It omits run
titles that repeat the Automation name. Its loading,
empty, and retry states do not replace Automation settings. It does not infer
queued or running work from terminal records.

`AutomationLifecycle` owns revision-checked actions in a fixed footer. Edit and
Delete use labeled icons there; list rows have no action menu. Public readers
can edit settings. Delete and lifecycle actions stay creator-only. The shared
shadcn Popover provides pause help beside those controls. The
scroll region above it owns the summary and settings. Creator, creation date,
connected accounts, run counts, and version history stay under About this
Automation. Selection changes remount the content and actions together.

Filters use a shadcn Popover at 768px and above and the shared BottomSheet below
that width. Both edit the same URL filters immediately. Active filter chips
remove one filter without clearing search, scope, or other filters. The mobile
sheet fits its controls instead of taking the full details height.

`AutomationDeleteDialog` names the Automation before deletion. It keeps errors
and retry inside the dialog and blocks dismissal while the request is pending.
Cancel returns focus to Delete. Successful deletion closes the selected details
and returns focus to the list. Success toasts confirm Save, Pause, Resume, and
Delete. Their state belongs to the mounted dashboard's Toaster provider.

## Run details

The Runs list and the executions list of one Automation open run details in
the shared `DetailsPanel`. A row does not open the Conversation. The `run`
search parameter selects the run, so a run link can be shared. Filters and the
query string stay when the selection changes. Each row also has an icon link
that opens the Conversation directly.

`AutomationRunDetails` owns the selection hook, the list frame, and the panel.
Both lists use it. `AutomationsPageLayout` gives both routes the same
independent list scroll as the Automation list. Closing returns focus to the
selected row. While details are open, Up and Down move the selection to the
next or previous visible row.

Details lead with the outcome and the recorded error. Duration, tokens, and
cost follow. Then the trigger, start and finish times, the accounts of the
dispatched version, the Automation version, and the run id. The Runs list also
links to the Automation. "Open conversation" is the header action when a
Conversation was recorded. Core reads these fields from the run record and the
dispatched Automation version. A field that core did not record is left out.

The executions and Runs browser journeys in `e2e/automations.spec.ts` cover
selection, the shared URL, keyboard movement, focus on close, and the row link.
