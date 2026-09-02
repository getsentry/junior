# API Surface

Use this reference for any Linear operation.

## Tools

- `linear_getIssue`: get one issue by UUID or identifier.
- `linear_searchIssues`: find issues before a create or update.
- `linear_createIssue`: create an issue as the installed Junior app.
- `linear_updateIssue`: update selected issue fields as the installed Junior app.
- `linear_createComment`: add a comment as the installed Junior app.
- `linear_listTeams`: resolve a team UUID.
- `linear_listProjects`: resolve an active project UUID.
- `linear_listWorkflowStates`: resolve one team's workflow state UUID.

The tools call Linear's GraphQL API with the installed Junior app. They do not use the requesting user's Linear account.

## Linear issue model constraints

- Every issue belongs to exactly one team.
- A new issue requires a title and team UUID.
- Workflow states are team-specific. Never infer a state UUID from a name.
- Linear priorities use numeric API values: `0` no priority, `1` urgent, `2` high, `3` medium, `4` low.
- Resolve project, state, team, and issue identifiers before a write.

## Operation patterns

- Inspect: resolve the issue, then fetch current state.
- Create: search for duplicates, resolve the team, then call `linear_createIssue`.
- Update: fetch current state, then send only requested fields to `linear_updateIssue`.
- Comment: resolve the exact issue before `linear_createComment`.
- Move state: list the team's states before updating `stateId`.

## OAuth

- One workspace admin installs the OAuth app with `actor=app`.
- Junior stores and refreshes the app tokens.
- Requests from conversations, scheduled tasks, and event tasks use the same app connection.
- Linear records changes as made by the Junior app, not the Slack user.
- If Linear rejects the refresh token, an admin must install the app again.
