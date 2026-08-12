# @sentry/junior-dashboard

The dashboard is an authenticated reporting surface over Junior conversation
read models. It does not participate in agent execution or mutate conversation
state. Signed-in users may update their own profile fields, such as display
name, through dashboard settings.

## Boundaries

- `createDashboardApp` mounts the dashboard routes and receives host
  configuration through `JuniorDashboardOptions`.
- Better Auth owns authentication; dashboard routes fail closed when identity
  or required configuration is missing.
- API schemas under `src/api/` define the client/server boundary.
- Plugin user pages use the core `/api/user-pages` contract and render under
  `/plugins/:plugin/:page/*`. Plugins choose primary dashboard navigation or the
  signed-in user menu. Core-rendered lists own metrics, search query state,
  cursor pagination, record inspection, destructive confirmation, and
  authenticated plugin REST actions.
- Conversation detail is a bounded TanStack Query resource that polls while
  active. Earlier event pages use a separate infinite query loaded on demand.
  The client derives one ordered transcript from those immutable responses;
  paginated reads never write into another resource's cache.
- The server adapts canonical runtime events into normalized reporting events.
  The dashboard reduces tool and subagent observations by stable identity into
  one row without interpreting Pi messages or host-only lifecycle shapes.
- Private conversation access requires authenticated authorization at the
  server boundary. Client-side route hiding is not authorization.
- The package remains stateless apart from normal auth/session infrastructure
  and signed-in profile settings. Junior conversation storage is the reporting
  authority; canonical user rows own profile fields such as display name.

Mock reporting data exists for local UI development only and must not be
reachable as a production fallback.

Browser journeys live in `e2e/`, with one Playwright spec per user-facing page.
Keep these journeys small. Use them for behavior that needs a real browser:
navigation, interaction, accessibility state, request contracts, and realistic
failure recovery. Use visual QA for layout, responsive rendering, styling, and
copy-only changes. Do not add pixel geometry, element size, computed style, or
fixed-delay checks to browser E2E.

Shared server and API setup belongs in `e2e/harness.ts`; page behavior does not
belong in a cross-page aggregate spec. Tests under `tests/` cover modules and
component integration without standing in for browser E2E.

Run `JUNIOR_DASHBOARD_COMPONENT_GALLERY=true pnpm dev` from the repository root
and open `/dev` to inspect the typed component fixtures.

## Type scale

Font sizes come from the named scale in `src/tailwind.css` (`text-2xs` through
`text-4xl`). Reserve `text-2xs` (12px) for compact badges and chart
annotations; use `text-xs` (13px) or larger for body copy, controls, subtext,
and standalone metadata. Prefer those steps over arbitrary `text-[Nrem]` values.

User-facing setup lives in
`packages/docs/src/content/docs/operate/dashboard.md`. Follow
`../../policies/data-redaction.md` and `../../policies/frontend-components.md`.
