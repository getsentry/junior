# System pages

- The URL selects a Workspace recipe: `/system/workspaces/:id` opens
  `WorkspaceDetails` beside the list.
- The list report has no snapshots. The detail read adds the current
  snapshot. Keep snapshot loading and errors inside the Snapshot row.
- Edit and Delete live in the panel header. List rows have no actions.
- `WorkspaceDeleteDialog` keeps errors in the dialog and blocks dismissal
  while the request runs.
- Close and Escape return focus to the selected row.

Browser coverage: `e2e/system.spec.ts`.
