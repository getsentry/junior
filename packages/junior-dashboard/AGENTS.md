# Dashboard

## Intent

- The dashboard is an authenticated reporting surface over Junior
  conversation read models. It does not take part in agent execution.
- It never changes conversation state, except that signed-in users can change
  their own profile fields.
- Junior conversation storage is the reporting authority. The package stays
  stateless apart from auth sessions and profile settings.
- `src/api/` schemas own the client/server boundary.

## Auth and privacy

- Core owns the Better Auth session. Routes fail closed when identity or
  required configuration is missing.
- Check access to private conversations on the server. Hidden client routes
  are not authorization.
- The server turns runtime events into privacy-safe reporting events. Follow
  `policies/data-redaction.md`.
- Mock reporting data is for local UI work only. It must never be a
  production fallback.
- The installable shell is static. Do not add a service worker or an offline
  cache.

## Conversation detail

- Detail and mailbox share one TanStack Query snapshot. Read the mailbox
  first, then history, and publish both in one render. Workers commit input
  before they acknowledge it, so input never disappears between queue and
  transcript.
- A local send stays visible until a server snapshot has its Message id. The
  browser and web ingress share one Message id function.
- Only Turn lifecycle events turn on the thinking indicator. Queued work is
  not thinking.
- Paginated event reads never write into the cache of another resource.
- Detail ETags save transfer and parsing only. Check access before a `304`.

## Browser assets

- Load Shiki grammars and the theme on demand from `client/code-languages.ts`.
  Do not import the full Shiki bundle.
- Cache content-hashed chunks privately. Keep the entry uncached.
- If highlighting cannot load, show plain text without a reload.

## Tests

- One Playwright spec per user-facing page in `e2e/`. Import `test` from
  `./test` and call `screenshot(page, name)` after load.
- Browser tests cover navigation, interaction, accessibility state, request
  contracts, and failure recovery. Use visual QA for layout and style. Do not
  assert pixel geometry, computed style, or fixed delays.
- Mocks and browser tests use one fixed time, `NOW`.

UI rules: `src/client/components/AGENTS.md` and
`policies/frontend-components.md`.
