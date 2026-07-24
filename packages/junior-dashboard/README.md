# @sentry/junior-dashboard

The dashboard is an authenticated reporting surface over Junior conversation
read models. It does not participate in agent execution or mutate conversation
state.

## Boundaries

- `createDashboardApp` mounts the dashboard routes and receives host
  configuration through `JuniorDashboardOptions`.
- Better Auth owns authentication; dashboard routes fail closed when identity
  or required configuration is missing.
- API schemas under `src/api/` define the client/server boundary.
- Conversation detail, backward event pages, and forward update pages use
  separate TanStack Query resources. The client derives one ordered transcript
  from those immutable responses; paginated reads never write into another
  resource's cache.
- Reporting projects only tool calls and model-visible results from agent
  steps. The dashboard correlates their start, call, and result facts by tool
  call id into one row without exposing the rest of model history.
- Private conversation access requires authenticated authorization at the
  server boundary. Client-side route hiding is not authorization.
- The package remains stateless apart from normal auth/session infrastructure;
  Junior conversation storage is the reporting authority.

Mock reporting data exists for local UI development only and must not be
reachable as a production fallback.

User-facing setup lives in
`packages/docs/src/content/docs/operate/dashboard.md`. Follow
`../../policies/data-redaction.md` and `../../policies/frontend-components.md`.
