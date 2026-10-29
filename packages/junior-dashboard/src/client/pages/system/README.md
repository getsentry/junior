# System pages

## Workspaces

`/system/workspaces` lists the Workspace recipes. The URL selects one recipe:
`/system/workspaces/:id` keeps the list and opens `WorkspaceDetails` in the
shared `DetailsPanel`. The panel is 400px wide at 1280px and above. Smaller
screens use the bottom sheet. Repository pages link to these details.

The panel shows the list item at once. The detail read adds the current
snapshot, because the list report does not include snapshots. Snapshot loading
and errors stay in the Snapshot row. Usage shows switches for the last 30 days.
Workspace switch counts are daily only.

Edit and Delete are in the panel header. List rows have no actions. Edit opens
the full-page editor at `/system/workspaces/:id/edit`. Save and Cancel return to
the details. A new Workspace opens its details after create.

Close and Escape return focus to the selected row. `WorkspaceDeleteDialog`
names the recipe, keeps errors inside the dialog, and blocks dismissal while the
request runs. A successful delete closes the details and shows a toast.

Browser coverage lives in `e2e/system.spec.ts`.
