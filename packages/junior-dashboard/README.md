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
- Reporting projections expose normalized visible messages, agent activity,
  artifacts, and tool summaries rather than raw provider payloads or runtime
  state.
- Private conversation access requires authenticated authorization at the
  server boundary. Client-side route hiding is not authorization.
- The package remains stateless apart from normal auth/session infrastructure;
  Junior conversation storage is the reporting authority.

Mock reporting data exists for local UI development only and must not be
reachable as a production fallback.

User-facing setup lives in
`packages/docs/src/content/docs/operate/dashboard.md`. Follow
`../../policies/data-redaction.md` and `../../policies/frontend-components.md`.
