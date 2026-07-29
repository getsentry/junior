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
- Plugin user pages use the core `/api/user-pages` contract and appear under
  the signed-in user menu at `/settings/plugins/:plugin/:page`. Core-rendered
  lists own search query state, cursor pagination, destructive confirmation,
  and authenticated plugin REST actions.
- Conversation detail is a bounded TanStack Query resource that polls while
  active. Earlier event pages use a separate infinite query loaded on demand.
  The client derives one ordered transcript from those immutable responses;
  paginated reads never write into another resource's cache.
- The server adapts canonical runtime events into normalized reporting events.
  The dashboard reduces tool and subagent observations by stable identity into
  one row without interpreting Pi messages or host-only lifecycle shapes.
- Private conversation access requires authenticated authorization at the
  server boundary. Client-side route hiding is not authorization.
- The package remains stateless apart from normal auth/session infrastructure;
  Junior conversation storage is the reporting authority.

Mock reporting data exists for local UI development only and must not be
reachable as a production fallback.

Browser journeys live in `e2e/`, with one Playwright spec per user-facing page.
Shared server and API setup belongs in `e2e/harness.ts`; page behavior does not
belong in a cross-page aggregate spec. Tests under `tests/` cover modules and
component integration without standing in for browser E2E.

Run `JUNIOR_DASHBOARD_COMPONENT_GALLERY=true pnpm dev` from the repository root
and open `/dev` to inspect the typed component fixtures.

User-facing setup lives in
`packages/docs/src/content/docs/operate/dashboard.md`. Follow
`../../policies/data-redaction.md` and `../../policies/frontend-components.md`.
